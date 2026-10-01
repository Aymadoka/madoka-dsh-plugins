import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import plugin, {
  headerValueFor,
  patchFetch,
  withStore,
  type FetchLike,
  type HeadersInitLike,
  type StoreState,
} from '../src/index.js'
import { echoServer, fakeCtx, streamListener } from './helpers.js'

describe('headerValueFor', () => {
  it('session-id mode: value equals the session id', () => {
    assert.equal(headerValueFor('conv-123', 'session-id', new Map()), 'conv-123')
  })

  it('uuid mode: opaque, stable, unique', () => {
    const table = new Map<string, string>()
    const value = headerValueFor('conv-123', 'uuid', table)
    assert.ok(typeof value === 'string' && value.length > 0)
    assert.notEqual(value, 'conv-123')
    assert.equal(headerValueFor('conv-123', 'uuid', table), value)
    assert.notEqual(headerValueFor('conv-456', 'uuid', table), value)
  })

  it('empty / null session ids are rejected', () => {
    assert.equal(headerValueFor('', 'session-id', new Map()), undefined)
    assert.equal(headerValueFor(null, 'session-id', new Map()), undefined)
    assert.equal(headerValueFor(undefined, 'session-id', new Map()), undefined)
  })
})

describe('withStore', () => {
  it('keeps store active across pulls', async () => {
    const als = new AsyncLocalStorage<StoreState>()
    const seen: Array<string | undefined> = []
    async function* gen(): AsyncGenerator<string> {
      seen.push(als.getStore()?.value)
      yield 'a'
      seen.push(als.getStore()?.value)
      yield 'b'
    }
    const wrapped = withStore(gen(), { value: 'V' }, als)
    const out: string[] = []
    for await (const chunk of wrapped) out.push(chunk)
    assert.deepEqual(out, ['a', 'b'])
    assert.deepEqual(seen, ['V', 'V'])
  })
})

describe('patchFetch', () => {
  it('injects the header only inside a store', async () => {
    const als = new AsyncLocalStorage<StoreState>()
    const calls: Array<{ input: unknown; headers: unknown }> = []
    const original: FetchLike = async (input: unknown, init?: { headers?: unknown }) => {
      calls.push({ input, headers: init?.headers })
      return 'ok'
    }
    const patched = patchFetch(original, als)
    await patched('https://x.test/v1', { headers: { a: '1' } })
    const first = calls[0]
    assert.ok(first)
    assert.equal(new Headers(first.headers as HeadersInitLike).get('x-opencode-session'), null)
    await als.run({ value: 'SID-1' }, () => patched('https://x.test/v1', { headers: { a: '1' } }))
    const inside = calls[1]
    assert.ok(inside)
    const insideHeaders = new Headers(inside.headers as HeadersInitLike)
    assert.equal(insideHeaders.get('x-opencode-session'), 'SID-1')
    assert.equal(insideHeaders.get('a'), '1')
    await als.run({ value: 'SID-2' }, () =>
      patched('https://x.test/v1', { headers: { 'x-opencode-session': 'mine' } }))
    const existing = calls[2]
    assert.ok(existing)
    assert.equal(new Headers(existing.headers as HeadersInitLike).get('x-opencode-session'), 'mine')
  })
})

describe('header end-to-end (echo server)', () => {
  it('opencode-go request carries x-opencode-session = session id', async () => {
    const realFetch = globalThis.fetch
    const { server, url } = await echoServer()
    try {
      const ctx = fakeCtx()
      plugin.apply(ctx, { providers: ['opencode-go'], mode: 'session-id' })
      const llmStream = streamListener(ctx)

      const adapterStream = async function* (tag: string): AsyncGenerator<unknown> {
        const res = await fetch(`${url}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'x', messages: [] }),
        })
        const echoed = await res.json()
        yield { tag, echoed }
      }

      const session = 'session-11111111-2222-3333-4444-555555555555'
      const chunks: any[] = []
      const out = llmStream(
        { provider: 'opencode-go', model: 'm', sessionId: session },
        () => adapterStream('a'),
      ) as AsyncIterable<any>
      for await (const chunk of out) chunks.push(chunk)
      assert.equal(chunks[0]?.echoed?.headers?.['x-opencode-session'], session)

      for (const cleanup of ctx.cleanups) {
        if (typeof cleanup === 'function') cleanup()
      }
      assert.equal(globalThis.fetch, realFetch)
    } finally {
      server.close()
      globalThis.fetch = realFetch
    }
  })

  it('non-opencode-go provider is untouched', async () => {
    const realFetch = globalThis.fetch
    const { server, url } = await echoServer()
    try {
      const ctx = fakeCtx()
      plugin.apply(ctx, { providers: ['opencode-go'], mode: 'session-id' })
      const llmStream = streamListener(ctx)

      const adapterStream = async function* (tag: string): AsyncGenerator<unknown> {
        const res = await fetch(`${url}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'x', messages: [] }),
        })
        const echoed = await res.json()
        yield { tag, echoed }
      }

      const session = 'session-11111111-2222-3333-4444-555555555555'
      const other: any[] = []
      const out = llmStream(
        { provider: 'deepseek-official', model: 'm', sessionId: session },
        () => adapterStream('b'),
      ) as AsyncIterable<any>
      for await (const chunk of out) other.push(chunk)
      assert.equal(other[0]?.echoed?.headers?.['x-opencode-session'], undefined)

      for (const cleanup of ctx.cleanups) {
        if (typeof cleanup === 'function') cleanup()
      }
    } finally {
      server.close()
      globalThis.fetch = realFetch
    }
  })

  it('opencode route is untouched (go-only scope)', async () => {
    const realFetch = globalThis.fetch
    const { server, url } = await echoServer()
    try {
      const ctx = fakeCtx()
      plugin.apply(ctx, { providers: ['opencode-go'], mode: 'session-id' })
      const llmStream = streamListener(ctx)

      const adapterStream = async function* (tag: string): AsyncGenerator<unknown> {
        const res = await fetch(`${url}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'x', messages: [] }),
        })
        const echoed = await res.json()
        yield { tag, echoed }
      }

      const session = 'session-11111111-2222-3333-4444-555555555555'
      // opencode (old name) must NOT match when only opencode-go is configured
      const legacy: any[] = []
      const out = llmStream(
        { provider: 'opencode', model: 'm', sessionId: session },
        () => adapterStream('c'),
      ) as AsyncIterable<any>
      for await (const chunk of out) legacy.push(chunk)
      assert.equal(legacy[0]?.echoed?.headers?.['x-opencode-session'], undefined)

      for (const cleanup of ctx.cleanups) {
        if (typeof cleanup === 'function') cleanup()
      }
    } finally {
      server.close()
      globalThis.fetch = realFetch
    }
  })
})
