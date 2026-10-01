// madoka-dsh-opencode-go-session
//
// Host plugin, OpenCode Go only. Two jobs:
//
//   1. ATTACH `x-opencode-session` (header half): OpenCode's relay pins every
//      request sharing the same `x-opencode-session` value to the same upstream
//      backend, keeping its prompt cache warm across the turns of one
//      conversation. Fixes 400 MissingSessionID. Default mode is `session-id`
//      (same as dsh-opencode-session): reuse the DSH session id that already
//      travels with each model call.
//
//   2. PUT DEEPSEEK V4.1 FIRST (settings half): once the `llm-pi-ai` settings
//      namespace is registered, detect the opencode-go catalog from the engine
//      itself (`llm.discoverModels`, no network for a catalog route) and place
//      `deepseek-v4.1-flash` at the FRONT of the route's `models` list via
//      settings.update. Seeds the list from the detected catalog when the user
//      configured none, and declares the route's baseURL when a listed model is
//      not in the catalog. No compat patching by design (flash only).

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

export const name = 'madoka-opencode-go-session'

// Activate only after the abstract `llm` service exists, so the waterfall
// event the header half listens on is already registered by its provider.
// `settings` is injected lazily in apply() so a profile without settings
// still gets the header fix.
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

export interface LlmService {
  discoverModels?(ns: string, filter?: unknown): Promise<unknown>
}

export interface PluginSettings {
  describe?(): unknown
  get?(ns: string): unknown
  section?(ns: string): unknown
  update?(ns: string, value: unknown): unknown
}

export interface PluginContext {
  logger: PluginLogger
  effect(fn: () => unknown, label?: string): unknown
  on(event: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }): () => void
  inject?(deps: string[], setup: (ctx: PluginContext) => void): void
  llm?: LlmService
  settings?: PluginSettings
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function modelIdOf(value: unknown): string | undefined {
  const id = toRecord(value)?.['id']
  return typeof id === 'string' ? id : undefined
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

export interface ModelLike {
  id: string
  [key: string]: unknown
}

export interface ModelDef extends ModelLike {
  name: string
  contextWindow: number
  maxTokens: number
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

// ---------------------------------------------------------------------------
// DeepSeek V4.1 auto-add half (opencode-go only, flash first, no compat)
// ---------------------------------------------------------------------------

const NS = 'llm-pi-ai'
const PROVIDER = 'opencode-go'

// OpenCode Go's OpenAI-compatible endpoint.
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

// Only Flash, no compat block by design (per confirmed scheme).
export const V4_1_MODELS: ModelDef[] = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
  },
]

const NS_WAIT_TIMEOUT_MS = 10000
const NS_WAIT_STEP_MS = 100

export interface RoutePatch {
  models?: ModelLike[]
  baseURL?: string
}

/**
 * The next models array with V4.1 Flash FIRST, user entries kept in order.
 * Returns null when already in shape (so callers skip the write).
 */
export function withV41ModelsFirst(existing: unknown): ModelLike[] | null {
  const models: unknown[] = Array.isArray(existing) ? existing : []
  const ours = V4_1_MODELS.map((def) => {
    const found = models.find((m) => modelIdOf(m) === def.id)
    // Keep the user's own entry verbatim (name/limits they tuned win).
    return found !== undefined ? found : { ...def }
  })
  const rest = models.filter((m) => !V4_1_MODELS.some((def) => def.id === modelIdOf(m)))
  const next = [...ours, ...rest]
  return JSON.stringify(next) === JSON.stringify(models) ? null : (next as ModelLike[])
}

/**
 * The patch to write for the `opencode-go` route, or null when in shape.
 */
export function planRouteUpdate(
  userProfile: unknown,
  resolvedRoute: unknown,
  catalog: unknown,
): RoutePatch | null {
  if (!Array.isArray(catalog)) return null
  const detected: ModelLike[] = catalog
    .filter((model) => {
      const id = modelIdOf(model)
      return id !== undefined && id.length > 0
    })
    .map((model) => model as ModelLike)
  const catalogIds = new Set(detected.map((model) => model.id))
  const stored: unknown = toRecord(userProfile)?.['models']
  const userConfigured = Array.isArray(stored) && stored.length > 0

  const listed: unknown[] = userConfigured
    ? (stored as unknown[])
    : detected.map((model) => (
      typeof model.name === 'string' && model.name.length > 0
        ? { id: model.id, name: model.name }
        : { id: model.id }
    ))
  const merged = withV41ModelsFirst(listed)
  const models = (merged ?? listed) as ModelLike[]

  const patch: RoutePatch = {}
  if (merged !== null) patch.models = models
  if (((toRecord(resolvedRoute)?.['baseURL'] as string | undefined) ?? '') === ''
    && models.some((model) => !catalogIds.has(model?.id))) {
    patch.baseURL = DEFAULT_BASE_URL
  }
  return Object.keys(patch).length > 0 ? patch : null
}

async function detectCatalogModels(ctx: PluginContext): Promise<ModelLike[] | undefined> {
  const llm = ctx.llm
  if (typeof llm?.discoverModels !== 'function') {
    ctx.logger?.warn('[opencode-go] llm.discoverModels() is unavailable; skipping the V4.1 auto-add')
    return undefined
  }
  try {
    const models: unknown = await llm.discoverModels(NS, { provider: PROVIDER })
    if (!Array.isArray(models)) return undefined
    return models.filter((model) => {
      const id = modelIdOf(model)
      return id !== undefined && id.length > 0
    })
  } catch (error) {
    ctx.logger?.warn(
      '[opencode-go] could not detect the "%s" model catalog: %s',
      PROVIDER,
      error instanceof Error ? error.message : String(error),
    )
    return undefined
  }
}

async function waitForNamespace(settings: PluginSettings): Promise<boolean> {
  const deadline = Date.now() + NS_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const desc: unknown = settings.describe?.()
      if (Array.isArray(desc) && desc.some((d) => toRecord(d)?.['ns'] === NS)) return true
    } catch {
      // not yet readable; keep polling
    }
    await sleep(NS_WAIT_STEP_MS)
  }
  return false
}

async function ensureV41Models(ctx: PluginContext, settings: PluginSettings): Promise<void> {
  const catalog = await detectCatalogModels(ctx)
  if (catalog === undefined) return

  let resolved: unknown
  try {
    resolved = settings.get?.(NS)
  } catch {
    return
  }
  const route = toRecord(toRecord(resolved)?.['providers'])?.[PROVIDER]
  if (route === undefined) return

  let userSection: unknown
  try {
    if (typeof settings.section !== 'function') {
      ctx.logger?.warn('[opencode-go] settings.section() is unavailable; skipping the V4.1 auto-add')
      return
    }
    userSection = settings.section(NS)
  } catch (error) {
    ctx.logger?.warn(
      '[opencode-go] reading the user settings section failed: %s',
      error instanceof Error ? error.message : String(error),
    )
    userSection = undefined
  }

  const userProviders = toRecord(toRecord(userSection)?.['providers'])
  const patch = planRouteUpdate(userProviders?.[PROVIDER], route, catalog)
  if (patch === null) return

  ctx.logger.info(
    '[opencode-go] detected %d "%s" model(s); putting %s first%s',
    catalog.length,
    PROVIDER,
    V4_1_MODELS.map((m) => m.id).join(', '),
    patch.baseURL === undefined ? '' : ` and declaring baseURL ${patch.baseURL}`,
  )
  await settings.update?.(NS, { providers: { [PROVIDER]: patch } })
}

function installAutoModels(ctx: PluginContext): void {
  const settings = ctx.settings
  if (settings === undefined) return
  let ensureChain: Promise<void> = Promise.resolve()

  const ensure = (): void => {
    ensureChain = ensureChain
      .then(() => ensureV41Models(ctx, settings))
      .catch((error) => {
        ctx.logger?.warn('[opencode-go] auto-add failed: %s', error?.message ?? String(error))
      })
  }

  ctx.effect(() => {
    const started = (async (): Promise<void> => {
      const ready = await waitForNamespace(settings)
      if (!ready) {
        ctx.logger?.warn(
          '[opencode-go] llm-pi-ai settings namespace not seen within %dms; skipping auto-add',
          NS_WAIT_TIMEOUT_MS,
        )
        return
      }
      ensure()
    })()

    const off = ctx.on('settings/document-updated', (ns) => {
      if (ns === NS) ensure()
    })

    return async (): Promise<void> => {
      off()
      await started
      await ensureChain
    }
  }, 'opencode-go.ensure-models')
}

export function apply(ctx: PluginContext, config?: unknown): void {
  installSessionHeader(ctx, config)
  // Lazy: keeps the header half working in profiles with no settings provider.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => installAutoModels(settingsCtx))
  } else if (ctx.settings) {
    installAutoModels(ctx)
  }
}

export default { name, inject, apply }
