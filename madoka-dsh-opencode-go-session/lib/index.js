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
// x-opencode-session header half (opencode-go only)
// ---------------------------------------------------------------------------

const SESSION_HEADER = 'x-opencode-session'

// Only this route. A custom name serving the same endpoint can be added
// through row config `providers`.
const DEFAULT_PROVIDERS = ['opencode-go']

function resolveConfig(config = {}) {
  const providers = Array.isArray(config.providers) && config.providers.length > 0
    ? config.providers.map((value) => String(value))
    : [...DEFAULT_PROVIDERS]
  // Same default as dsh-opencode-session: reuse the DSH session id.
  const mode = config.mode === 'uuid' ? 'uuid' : 'session-id'
  const debug = config.debug === true
  const debugFile = typeof config.debugFile === 'string' && config.debugFile.length > 0
    ? config.debugFile
    : undefined
  return { providers: new Set(providers), mode, debug, debugFile }
}

/** Fire-and-forget append of one debug record; failures only log a warning. */
function recordDebug(ctx, file, entry) {
  appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8').catch((error) => {
    ctx.logger.warn('[opencode-go] debugFile write failed: %s', error?.message ?? String(error))
  })
}

/** Derive the header value for one DSH session id. */
export function headerValueFor(sessionId, mode, table) {
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
export function withStore(iterable, store, als) {
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      return als.run(store, () => iterator.next())
    },
    async return(value) {
      if (typeof iterator.return === 'function') {
        try {
          return await iterator.return(value)
        } catch {
          // The downstream stream may already be torn down; treat as done.
        }
      }
      return { done: true, value }
    },
    async throw(error) {
      if (typeof iterator.throw === 'function') {
        return als.run(store, () => iterator.throw(error))
      }
      throw error
    },
  }
}

/** True when the outgoing request already carries the session header. */
function hasSessionHeader(input, init) {
  const source = init?.headers
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
  if (source === undefined) return false
  try {
    return new Headers(source).has(SESSION_HEADER)
  } catch {
    return false
  }
}

/**
 * Build a patched fetch that injects the header while a store is active.
 */
export function patchFetch(original, als) {
  return function patchedFetch(input, init) {
    const state = als.getStore()
    if (state && !hasSessionHeader(input, init)) {
      const headers = new Headers(
        init?.headers
          ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
      )
      headers.set(SESSION_HEADER, state.value)
      return original.call(this, input, { ...init, headers })
    }
    return original.apply(this, arguments)
  }
}

function installSessionHeader(ctx, config) {
  const { providers, mode, debug, debugFile } = resolveConfig(config)
  const als = new AsyncLocalStorage()
  const uuidBySession = new Map()

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    ctx.logger.warn('[opencode-go] globalThis.fetch is unavailable; cannot inject x-opencode-session')
    return
  }

  const patched = patchFetch(originalFetch, als)

  ctx.effect(() => {
    globalThis.fetch = patched
    ctx.logger.info(
      '[opencode-go] active for providers [%s] with mode %s',
      [...providers].join(', '),
      mode,
    )
    return () => {
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch
    }
  }, 'opencode-go.fetch-patch')

  ctx.on('llm/stream', (options, next) => {
    if (options === undefined || options === null || typeof options !== 'object') return next()
    if (!providers.has(String(options.provider))) return next()
    const sessionId = options.sessionId
    if (sessionId === undefined || sessionId === null) return next()
    const value = headerValueFor(sessionId, mode, uuidBySession)
    if (value === undefined) return next()

    let downstream
    try {
      downstream = next()
    } catch (error) {
      throw error
    }
    if (downstream === undefined || downstream === null) return downstream
    if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream

    if (debug || debugFile !== undefined) {
      const entry = {
        ts: new Date().toISOString(),
        provider: options.provider,
        model: options.model,
        session: String(sessionId),
        header: SESSION_HEADER,
        value,
      }
      if (debugFile !== undefined) recordDebug(ctx, debugFile, entry)
      if (debug) {
        ctx.logger.info(
          '[opencode-go] streaming provider "%s" with %s=%s',
          options.provider,
          SESSION_HEADER,
          value,
        )
      }
    }
    return withStore(downstream, { value }, als)
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
export const V4_1_MODELS = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
  },
]

const NS_WAIT_TIMEOUT_MS = 10000
const NS_WAIT_STEP_MS = 100

/**
 * The next models array with V4.1 Flash FIRST, user entries kept in order.
 * Returns null when already in shape (so callers skip the write).
 */
export function withV41ModelsFirst(existing) {
  const models = Array.isArray(existing) ? existing : []
  const ours = V4_1_MODELS.map((def) => {
    const found = models.find((m) => m?.id === def.id)
    // Keep the user's own entry verbatim (name/limits they tuned win).
    return found !== undefined ? found : { ...def }
  })
  const rest = models.filter((m) => !V4_1_MODELS.some((def) => def.id === m?.id))
  const next = [...ours, ...rest]
  return JSON.stringify(next) === JSON.stringify(models) ? null : next
}

/**
 * The patch to write for the `opencode-go` route, or null when in shape.
 */
export function planRouteUpdate(userProfile, resolvedRoute, catalog) {
  if (!Array.isArray(catalog)) return null
  const detected = catalog.filter((model) => typeof model?.id === 'string' && model.id.length > 0)
  const catalogIds = new Set(detected.map((model) => model.id))
  const stored = Array.isArray(userProfile?.models) ? userProfile.models : undefined
  const userConfigured = stored !== undefined && stored.length > 0

  const listed = userConfigured ? stored : detected.map((model) => (
    typeof model.name === 'string' && model.name.length > 0
      ? { id: model.id, name: model.name }
      : { id: model.id }
  ))
  const merged = withV41ModelsFirst(listed)
  const models = merged ?? listed

  const patch = {}
  if (merged !== null) patch.models = models
  if ((resolvedRoute?.baseURL ?? '') === '' && models.some((model) => !catalogIds.has(model?.id))) {
    patch.baseURL = DEFAULT_BASE_URL
  }
  return Object.keys(patch).length > 0 ? patch : null
}

async function detectCatalogModels(ctx) {
  const llm = ctx.llm
  if (typeof llm?.discoverModels !== 'function') {
    ctx.logger?.warn('[opencode-go] llm.discoverModels() is unavailable; skipping the V4.1 auto-add')
    return undefined
  }
  try {
    const models = await llm.discoverModels(NS, { provider: PROVIDER })
    if (!Array.isArray(models)) return undefined
    return models.filter((model) => typeof model?.id === 'string' && model.id.length > 0)
  } catch (error) {
    ctx.logger?.warn(
      '[opencode-go] could not detect the "%s" model catalog: %s',
      PROVIDER,
      error?.message ?? String(error),
    )
    return undefined
  }
}

async function waitForNamespace(settings) {
  const deadline = Date.now() + NS_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const desc = settings.describe?.()
      if (Array.isArray(desc) && desc.some((d) => d.ns === NS)) return true
    } catch {
      // not yet readable; keep polling
    }
    await sleep(NS_WAIT_STEP_MS)
  }
  return false
}

async function ensureV41Models(ctx, settings) {
  const catalog = await detectCatalogModels(ctx)
  if (catalog === undefined) return

  let resolved
  try {
    resolved = settings.get(NS)
  } catch {
    return
  }
  const route = resolved?.providers?.[PROVIDER]
  if (!route) return

  let userSection
  try {
    if (typeof settings.section !== 'function') {
      ctx.logger?.warn('[opencode-go] settings.section() is unavailable; skipping the V4.1 auto-add')
      return
    }
    userSection = settings.section(NS)
  } catch (error) {
    ctx.logger?.warn('[opencode-go] reading the user settings section failed: %s', error?.message ?? String(error))
    userSection = undefined
  }

  const patch = planRouteUpdate(userSection?.providers?.[PROVIDER], route, catalog)
  if (patch === null) return

  ctx.logger.info(
    '[opencode-go] detected %d "%s" model(s); putting %s first%s',
    catalog.length,
    PROVIDER,
    V4_1_MODELS.map((m) => m.id).join(', '),
    patch.baseURL === undefined ? '' : ` and declaring baseURL ${patch.baseURL}`,
  )
  await settings.update(NS, { providers: { [PROVIDER]: patch } })
}

function installAutoModels(ctx, config = {}) {
  const settings = ctx.settings
  let ensureChain = Promise.resolve()

  const ensure = () => {
    ensureChain = ensureChain
      .then(() => ensureV41Models(ctx, settings))
      .catch((error) => {
        ctx.logger?.warn('[opencode-go] auto-add failed: %s', error?.message ?? String(error))
      })
  }

  ctx.effect(() => {
    const started = (async () => {
      const ready = await waitForNamespace(settings)
      if (!ready) {
        ctx.logger?.warn('[opencode-go] llm-pi-ai settings namespace not seen within %dms; skipping auto-add', NS_WAIT_TIMEOUT_MS)
        return
      }
      ensure()
    })()

    const off = ctx.on('settings/document-updated', (ns) => {
      if (ns === NS) ensure()
    })

    return async () => {
      off()
      await started
      await ensureChain
    }
  }, 'opencode-go.ensure-models')
}

export function apply(ctx, config) {
  installSessionHeader(ctx, config)
  // Lazy: keeps the header half working in profiles with no settings provider.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => installAutoModels(settingsCtx, config))
  } else if (ctx.settings) {
    installAutoModels(ctx, config)
  }
}

export default { name, inject, apply }
