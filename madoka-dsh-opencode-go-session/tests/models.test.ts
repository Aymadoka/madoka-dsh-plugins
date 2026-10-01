import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  V4_1_MODELS,
  planRouteUpdate,
  withV41ModelsFirst,
} from '../src/index.js'

const CATALOG = [
  { id: 'minimax-m3', name: 'MiniMax-M3' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'kimi-k3', name: 'Kimi K3' },
]

describe('V4_1_MODELS', () => {
  it('catalog is flash only', () => {
    assert.equal(V4_1_MODELS.length, 1)
    const flash = V4_1_MODELS[0]
    assert.ok(flash)
    assert.equal(flash.id, 'deepseek-v4.1-flash')
  })
})

describe('withV41ModelsFirst', () => {
  it('puts flash first and keeps order', () => {
    const next = withV41ModelsFirst([
      { id: 'deepseek-v4-flash' },
      { id: 'kimi-k2' },
    ])
    assert.ok(next)
    assert.deepEqual(next.map((m) => m.id), ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'kimi-k2'])
  })

  it('moves an existing flash to front', () => {
    const next = withV41ModelsFirst([
      { id: 'deepseek-v4-flash' },
      { id: 'kimi-k2' },
      { id: 'deepseek-v4.1-flash' },
    ])
    assert.ok(next)
    assert.deepEqual(next.map((m) => m.id), ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'kimi-k2'])
  })

  it('is idempotent', () => {
    const flash = V4_1_MODELS[0]
    assert.ok(flash)
    const already = [{ ...flash }, { id: 'deepseek-v4-flash' }]
    assert.equal(withV41ModelsFirst(already), null)
  })
})

describe('planRouteUpdate', () => {
  it('seeds a full list when unconfigured', () => {
    const patch = planRouteUpdate(undefined, {}, CATALOG)
    assert.ok(patch?.models)
    assert.deepEqual(patch.models.map((m) => m.id), [
      'deepseek-v4.1-flash',
      'minimax-m3',
      'deepseek-v4-flash',
      'kimi-k3',
    ])
    assert.equal(patch.baseURL, 'https://opencode.ai/zen/go/v1')
  })

  it('extends a user list and keeps order', () => {
    const patch = planRouteUpdate(
      { models: [{ id: 'deepseek-v4-flash' }, { id: 'kimi-k3' }] },
      { baseURL: 'https://opencode.ai/zen/go/v1' },
      CATALOG,
    )
    assert.ok(patch?.models)
    assert.deepEqual(patch.models.map((m) => m.id), ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'kimi-k3'])
    assert.equal(patch.baseURL, undefined)
  })

  it('is idempotent, refuses to guess', () => {
    const flash = V4_1_MODELS[0]
    assert.ok(flash)
    assert.equal(
      planRouteUpdate({ models: [{ ...flash }, { id: 'x' }] }, { baseURL: 'x' }, CATALOG),
      null,
    )
    assert.equal(planRouteUpdate(undefined, {}, undefined), null)
  })
})
