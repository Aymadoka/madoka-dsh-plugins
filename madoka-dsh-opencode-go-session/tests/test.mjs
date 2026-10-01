// madoka-dsh-opencode-go-session tests (no network, no engine).
// Run: node tests/test.mjs

import assert from 'node:assert/strict'
import http from 'node:http'
import plugin, {
  V4_1_MODELS,
  headerValueFor,
  patchFetch,
  planRouteUpdate,
  withStore,
  withV41ModelsFirst,
} from '../lib/index.js'
import { AsyncLocalStorage } from 'node:async_hooks'

let passed = 0
function check(label, fn) {
  fn()
  passed++
  console.log('  ✓', label)
}

// ---- fake cordis ctx (only what apply() touches) ----
function fakeCtx() {
  const listeners = new Map()
  const ctx = {
    listeners,
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const cleanup = fn()
      ctx.cleanups.push(cleanup)
      return () => cleanup?.()
    },
    cleanups: [],
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => {
        const list = listeners.get(name) ?? []
        const i = list.indexOf(listener)
        if (i >= 0) list.splice(i, 1)
      }
    },
  }
  return ctx
}

const realFetch = globalThis.fetch

function echoServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ url: req.url, headers: req.headers }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

console.log('madoka-dsh-opencode-go-session tests')

// --- header half: session-id default ---
check('session-id mode: value equals the session id', () => {
  assert.equal(headerValueFor('conv-123', 'session-id', new Map()), 'conv-123')
})

check('uuid mode: opaque, stable, unique', () => {
  const table = new Map()
  const value = headerValueFor('conv-123', 'uuid', table)
  assert.ok(typeof value === 'string' && value.length > 0)
  assert.notEqual(value, 'conv-123')
  assert.equal(headerValueFor('conv-123', 'uuid', table), value)
  assert.notEqual(headerValueFor('conv-456', 'uuid', table), value)
})

check('empty / null session ids are rejected', () => {
  assert.equal(headerValueFor('', 'session-id', new Map()), undefined)
  assert.equal(headerValueFor(null, 'session-id', new Map()), undefined)
  assert.equal(headerValueFor(undefined, 'session-id', new Map()), undefined)
})

{
  const als = new AsyncLocalStorage()
  const seen = []
  async function* gen() {
    seen.push(als.getStore()?.value)
    yield 'a'
    seen.push(als.getStore()?.value)
    yield 'b'
  }
  const wrapped = withStore(gen(), { value: 'V' }, als)
  const out = []
  for await (const chunk of wrapped) out.push(chunk)
  assert.deepEqual(out, ['a', 'b'])
  assert.deepEqual(seen, ['V', 'V'])
  passed++
  console.log('  ✓ withStore keeps store active across pulls')
}

{
  const als = new AsyncLocalStorage()
  const calls = []
  const original = async (input, init) => {
    calls.push({ input, headers: init?.headers })
    return 'ok'
  }
  const patched = patchFetch(original, als)
  await patched('https://x.test/v1', { headers: { a: '1' } })
  assert.equal(new Headers(calls[0].headers).get('x-opencode-session'), null)
  await als.run({ value: 'SID-1' }, () => patched('https://x.test/v1', { headers: { a: '1' } }))
  const inside = new Headers(calls[1].headers)
  assert.equal(inside.get('x-opencode-session'), 'SID-1')
  assert.equal(inside.get('a'), '1')
  await als.run({ value: 'SID-2' }, () =>
    patched('https://x.test/v1', { headers: { 'x-opencode-session': 'mine' } }))
  assert.equal(new Headers(calls[2].headers).get('x-opencode-session'), 'mine')
  passed++
  console.log('  ✓ patchFetch injects the header only inside a store')
}

// --- model half ---
check('V4_1 catalog is flash only', () => {
  assert.equal(V4_1_MODELS.length, 1)
  assert.equal(V4_1_MODELS[0].id, 'deepseek-v4.1-flash')
})

check('withV41ModelsFirst puts flash first and keeps order', () => {
  const next = withV41ModelsFirst([
    { id: 'deepseek-v4-flash' },
    { id: 'kimi-k2' },
  ])
  assert.deepEqual(next.map((m) => m.id), ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'kimi-k2'])
})

check('withV41ModelsFirst moves an existing flash to front', () => {
  const next = withV41ModelsFirst([
    { id: 'deepseek-v4-flash' },
    { id: 'kimi-k2' },
    { id: 'deepseek-v4.1-flash' },
  ])
  assert.deepEqual(next.map((m) => m.id), ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'kimi-k2'])
})

check('withV41ModelsFirst is idempotent', () => {
  const already = [{ ...V4_1_MODELS[0] }, { id: 'deepseek-v4-flash' }]
  assert.equal(withV41ModelsFirst(already), null)
})

const CATALOG = [
  { id: 'minimax-m3', name: 'MiniMax-M3' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'kimi-k3', name: 'Kimi K3' },
]

check('planRouteUpdate seeds a full list when unconfigured', () => {
  const patch = planRouteUpdate(undefined, {}, CATALOG)
  assert.deepEqual(patch.models.map((m) => m.id), [
    'deepseek-v4.1-flash',
    'minimax-m3',
    'deepseek-v4-flash',
    'kimi-k3',
  ])
  assert.equal(patch.baseURL, 'https://opencode.ai/zen/go/v1')
})

check('planRouteUpdate extends a user list and keeps order', () => {
  const patch = planRouteUpdate(
    { models: [{ id: 'deepseek-v4-flash' }, { id: 'kimi-k3' }] },
    { baseURL: 'https://opencode.ai/zen/go/v1' },
    CATALOG,
  )
  assert.deepEqual(patch.models.map((m) => m.id), ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'kimi-k3'])
  assert.equal(patch.baseURL, undefined)
})

check('planRouteUpdate is idempotent, refuses to guess', () => {
  assert.equal(
    planRouteUpdate({ models: [{ ...V4_1_MODELS[0] }, { id: 'x' }] }, { baseURL: 'x' }, CATALOG),
    null,
  )
  assert.equal(planRouteUpdate(undefined, {}, undefined), null)
})

// --- end-to-end header through echo server ---
const { server, url } = await echoServer()
try {
  const ctx = fakeCtx()
  plugin.apply(ctx, { providers: ['opencode-go'], mode: 'session-id' })
  const llmStream = ctx.listeners.get('llm/stream')[0]

  const adapterStream = async function* (tag) {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    })
    const echoed = await res.json()
    yield { tag, echoed }
  }

  const session = 'session-11111111-2222-3333-4444-555555555555'
  const chunks = []
  for await (const chunk of llmStream({ provider: 'opencode-go', model: 'm', sessionId: session }, () => adapterStream('a'))) chunks.push(chunk)
  assert.equal(chunks[0].echoed.headers['x-opencode-session'], session)
  passed++
  console.log('  ✓ opencode-go request carries x-opencode-session = session id')

  const other = []
  for await (const chunk of llmStream({ provider: 'deepseek-official', model: 'm', sessionId: session }, () => adapterStream('b'))) other.push(chunk)
  assert.equal(other[0].echoed.headers['x-opencode-session'], undefined)
  passed++
  console.log('  ✓ non-opencode-go provider is untouched')

  // opencode (old name) must NOT match when only opencode-go is configured
  const legacy = []
  for await (const chunk of llmStream({ provider: 'opencode', model: 'm', sessionId: session }, () => adapterStream('c'))) legacy.push(chunk)
  assert.equal(legacy[0].echoed.headers['x-opencode-session'], undefined)
  passed++
  console.log('  ✓ opencode route is untouched (go-only scope)')

  for (const cleanup of ctx.cleanups) cleanup()
  assert.equal(globalThis.fetch, realFetch)
} finally {
  server.close()
  globalThis.fetch = realFetch
}

console.log(`\nall ${passed} checks passed`)
