// madoka-dsh-opencode-go-session
//
// Host plugin, OpenCode Go only. One job:
//
//   ATTACH `x-opencode-session`: OpenCode's relay pins every
//   request sharing the same `x-opencode-session` value to the same upstream
//   backend, keeping its prompt cache warm across the turns of one
//   conversation. Fixes 400 MissingSessionID. Default mode is `session-id`
//   (same as dsh-opencode-session): reuse the DSH session id that already
//   travels with each model call.

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'

export const name = 'madoka-opencode-go-session'

// Activate only after the abstract `llm` service exists, so the waterfall
// event the header half listens on is already registered by its provider.
export const inject = ['llm']

// ---------------------------------------------------------------------------
// Narrow host seam (duck-typed on purpose: the DSH service packages are
// provided by the host at runtime and are not npm-installable, so this
// plugin imports nothing but node: builtins).
// ---------------------------------------------------------------------------

export interface PluginLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export interface PluginContext {
  logger: PluginLogger
  effect(fn: () => unknown, label?: string): unknown
  on(event: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }): () => void
  inject?(deps: string[], setup: (ctx: PluginContext) => void): void
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

// ---------------------------------------------------------------------------
// x-opencode-session header half (opencode-go only)
// ---------------------------------------------------------------------------

const SESSION_HEADER = 'x-opencode-session'

// Only this route. A custom name serving the same endpoint can be added
// through row config `providers`.
const DEFAULT_PROVIDERS = ['opencode-go']

export type SessionMode = 'session-id' | 'uuid'

export interface PluginConfig {
  providers: Set<string>
  mode: SessionMode
  debug: boolean
  debugFile: string | undefined
}

export interface StoreState {
  value: string
}

function resolveConfig(config: unknown = {}): PluginConfig {
  const raw = toRecord(config) ?? {}
  const providers = Array.isArray(raw['providers']) && (raw['providers'] as unknown[]).length > 0
    ? (raw['providers'] as unknown[]).map((value) => String(value))
    : [...DEFAULT_PROVIDERS]
  // Same default as dsh-opencode-session: reuse the DSH session id.
  const mode: SessionMode = raw['mode'] === 'uuid' ? 'uuid' : 'session-id'
  const debug = raw['debug'] === true
  const debugFile = typeof raw['debugFile'] === 'string' && (raw['debugFile'] as string).length > 0
    ? (raw['debugFile'] as string)
    : undefined
  return { providers: new Set(providers), mode, debug, debugFile }
}

/** Fire-and-forget append of one debug record; failures only log a warning. */
function recordDebug(ctx: PluginContext, file: string, entry: unknown): void {
  appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8').catch((error) => {
    ctx.logger.warn('[opencode-go] debugFile write failed: %s', error?.message ?? String(error))
  })
}

/** Derive the header value for one DSH session id. */
export function headerValueFor(
  sessionId: unknown,
  mode: SessionMode,
  table: Map<string, string>,
): string | undefined {
  if (sessionId === undefined || sessionId === null) return undefined
  const raw = String(sessionId)
  if (raw.length === 0) return undefined
  if (mode !== 'uuid') return raw
  let value = table.get(raw)
  if (value === undefined) {
    value = randomUUID()
    table.set(raw, value)
  }
  return value
}

/**
 * Wrap a downstream async iterable so every pull executes inside an
 * AsyncLocalStorage store.
 */
export function withStore<T>(
  iterable: AsyncIterable<T> | AsyncIterator<T>,
  store: StoreState,
  als: AsyncLocalStorage<StoreState>,
): AsyncIterableIterator<T> {
  const iterator: AsyncIterator<T> = typeof (iterable as AsyncIterable<T>)[Symbol.asyncIterator] === 'function'
    ? (iterable as AsyncIterable<T>)[Symbol.asyncIterator]()
    : (iterable as AsyncIterator<T>)
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next(): Promise<IteratorResult<T>> {
      return als.run(store, () => iterator.next())
    },
    async return(value?: unknown): Promise<IteratorResult<T>> {
      if (typeof iterator.return === 'function') {
        try {
          return await iterator.return(value as any)
        } catch {
          // The downstream stream may already be torn down; treat as done.
        }
      }
      return { done: true, value: undefined as unknown as T }
    },
    async throw(error?: unknown): Promise<IteratorResult<T>> {
      if (typeof iterator.throw === 'function') {
        return als.run(store, () => iterator.throw!(error))
      }
      throw error
    },
  }
}

function headersOfInit(init: unknown): unknown {
  return toRecord(init)?.['headers']
}

/** True when the outgoing request already carries the session header. */
function hasSessionHeader(input: unknown, init: unknown): boolean {
  const source = headersOfInit(init)
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
  if (source === undefined) return false
  try {
    return new Headers(source as HeadersInitLike).has(SESSION_HEADER)
  } catch {
    return false
  }
}

export type FetchLike = (input: any, init?: any) => unknown

/** Headers 构造器接受的初始化形状（不依赖 DOM lib）。 */
export type HeadersInitLike = ConstructorParameters<typeof Headers>[0]

/**
 * Build a patched fetch that injects the header while a store is active.
 */
export function patchFetch(
  original: FetchLike,
  als: AsyncLocalStorage<StoreState>,
): FetchLike {
  return function patchedFetch(this: unknown, ...args: [input: unknown, init?: unknown]): unknown {
    const [input, init] = args
    const state = als.getStore()
    if (state && !hasSessionHeader(input, init)) {
      const headers = new Headers(
        headersOfInit(init) as HeadersInitLike | undefined
          ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
      )
      headers.set(SESSION_HEADER, state.value)
      const nextInit = { ...(toRecord(init) ?? {}), headers }
      return original.call(this, input, nextInit)
    }
    return original.apply(this, args)
  }
}

function installSessionHeader(ctx: PluginContext, config: unknown): void {
  const { providers, mode, debug, debugFile } = resolveConfig(config)
  const als = new AsyncLocalStorage<StoreState>()
  const uuidBySession = new Map<string, string>()

  const originalFetch: unknown = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    ctx.logger.warn('[opencode-go] globalThis.fetch is unavailable; cannot inject x-opencode-session')
    return
  }

  const patched = patchFetch(originalFetch as FetchLike, als)

  ctx.effect(() => {
    globalThis.fetch = patched as typeof fetch
    ctx.logger.info(
      '[opencode-go] active for providers [%s] with mode %s',
      [...providers].join(', '),
      mode,
    )
    return () => {
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch as typeof fetch
    }
  }, 'opencode-go.fetch-patch')

  ctx.on('llm/stream', (options, next) => {
    if (options === undefined || options === null || typeof options !== 'object') return next()
    if (!providers.has(String((options as { provider?: unknown }).provider))) return next()
    const sessionId = (options as { sessionId?: unknown }).sessionId
    if (sessionId === undefined || sessionId === null) return next()
    const value = headerValueFor(sessionId, mode, uuidBySession)
    if (value === undefined) return next()

    let downstream: unknown
    try {
      downstream = next()
    } catch (error) {
      throw error
    }
    if (downstream === undefined || downstream === null) return downstream
    if (typeof (downstream as Record<symbol, unknown>)[Symbol.asyncIterator] !== 'function') return downstream

    if (debug || debugFile !== undefined) {
      const entry = {
        ts: new Date().toISOString(),
        provider: (options as { provider?: unknown }).provider,
        model: (options as { model?: unknown }).model,
        session: String(sessionId),
        header: SESSION_HEADER,
        value,
      }
      if (debugFile !== undefined) recordDebug(ctx, debugFile, entry)
      if (debug) {
        ctx.logger.info(
          '[opencode-go] streaming provider "%s" with %s=%s',
          (options as { provider?: unknown }).provider,
          SESSION_HEADER,
          value,
        )
      }
    }
    return withStore(downstream as AsyncIterable<unknown>, { value }, als)
  }, { prepend: true })
}

export function apply(ctx: PluginContext, config?: unknown): void {
  installSessionHeader(ctx, config)
}

export default { name, inject, apply }
