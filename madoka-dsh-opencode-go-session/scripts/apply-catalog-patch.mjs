// apply-catalog-patch.mjs
//
// Put `deepseek-v4.1-flash` into the pi-ai built-in catalog that DSH Desktop
// ships, so the model shows up inside the `opencode-go` group with no profile
// configuration at all.
//
// WHY A SCRIPT. DSH Desktop 0.1.7 cannot be told about a catalog-unknown model
// any other way:
//   * the host has no settings service, so a plugin cannot write the route's
//     `models` at runtime (the log says: "this host's settings service has no
//     register()");
//   * declaring the model in a profile instead is possible but WRONG for this
//     route: the engine resolves a model's protocol and endpoint as
//       api     = route.api     ?? catalogModel.api     ?? sharedCatalogApi
//       baseUrl = route.baseURL ?? catalogModel.baseUrl ?? providerBaseUrl
//     so a route-level `api`/`baseURL` OVERRIDES every model's own catalog value
//     — and opencode-go spans three protocols and two baseUrls, which is why
//     adding one model that way silently breaks six others.
//   * model entries carry no `api`/`baseURL` of their own, so there is no way to
//     scope the declaration to the one model that needs it.
//
// Editing the catalog itself side-steps all of it: the new entry carries its own
// `api` and `baseUrl`, every other model keeps its own, and no route-level value
// is introduced. The cost is that a DSH Desktop update restores the shipped file
// — re-run this script afterwards. It is idempotent, so running it twice is safe.
//
// Usage:
//   node scripts/apply-catalog-patch.mjs [--dry-run] [--root <pi-ai-package-dir>]
//
// The default target is the catalog file of the DSH Desktop install; `--root`
// points at another `@earendil-works/pi-ai` package directory (a different
// install location, or a test fixture).

import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Model this patch adds. */
export const MODEL_ID = 'deepseek-v4.1-flash'

/** Path of the catalog file inside a pi-ai package directory. */
const CATALOG_RELATIVE = join('dist', 'providers', 'data', 'opencode-go.json')

/**
 * Where DSH Desktop keeps the pi-ai package. Overridable with `--root`.
 */
const DEFAULT_ROOT = 'D:\\AnyWhere\\DSH Desktop\\resources\\app\\node_modules\\@earendil-works\\pi-ai'

/**
 * The catalog entry, byte-for-byte the shape its sibling `deepseek-v4-flash`
 * carries in the same file — including the DeepSeek wire `compat` and the
 * thinking levels, so the model is treated as the reasoning model it is.
 *
 * Field order is deliberate: it mirrors the shipped sibling, which keeps the
 * patched file diffable against the original.
 */
export const ENTRY = {
  id: MODEL_ID,
  name: 'DeepSeek V4.1 Flash',
  api: 'openai-completions',
  provider: 'opencode-go',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: 'deepseek',
  },
  contextWindow: 1000000,
  maxTokens: 384000,
  thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
}

// The catalog is a single minified line whose first group is the one the entry
// is inserted into. `flattenModelCatalog` is `Object.assign({}, ...groups)`, so
// insertion order inside the FIRST group is what puts a model first in the
// picker — the group's name means nothing at runtime; the entry's own `api`
// field decides the protocol.
const ANCHOR = '{"anthropic-messages":{'

/**
 * Has the patch already been applied?
 *
 * Keyed on the model id, not on the anchor, so a re-run after a partial or
 * hand-made edit is still recognised as "already there" instead of doubling the
 * entry (a duplicate id would make the catalog invalid).
 *
 * @param {string} raw - the catalog file's text.
 * @returns {boolean}
 */
export function isPatched(raw) {
  return raw.includes(`"${MODEL_ID}"`)
}

/**
 * The patched catalog text, or the input unchanged when already patched.
 *
 * Pure: it neither reads nor writes anything, so the caller can validate the
 * result before anything touches the disk.
 *
 * @param {string} raw - the catalog file's text.
 * @param {object} [entry] - the entry to insert.
 * @returns {string} the new file text.
 * @throws {Error} when the anchor is missing (an unexpected catalog shape).
 */
export function patchCatalog(raw, entry = ENTRY) {
  if (isPatched(raw)) return raw
  const at = raw.indexOf(ANCHOR)
  if (at === -1) {
    throw new Error(`catalog anchor ${ANCHOR} not found; the shipped catalog shape changed`)
  }
  const insertAt = at + ANCHOR.length
  // A non-empty group needs the separator; an empty one (`{...:{}}`) must not
  // get a trailing comma, which JSON does not allow.
  const separator = raw[insertAt] === '}' ? '' : ','
  const inserted = `"${entry.id}":${JSON.stringify(entry)}${separator}`
  return raw.slice(0, insertAt) + inserted + raw.slice(insertAt)
}

/** Parse the CLI arguments. */
function parseArgs(argv) {
  const args = { dryRun: false, root: DEFAULT_ROOT }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--root') {
      const value = argv[++i]
      if (value === undefined) throw new Error('--root needs a directory')
      args.root = value
    } else throw new Error(`unknown argument "${arg}"`)
  }
  return args
}

async function main() {
  const { dryRun, root } = parseArgs(process.argv.slice(2))
  const file = join(root, CATALOG_RELATIVE)
  if (!existsSync(file)) {
    console.error(`catalog not found: ${file}`)
    console.error('pass --root <pi-ai package dir> when the install lives elsewhere')
    process.exitCode = 1
    return
  }

  const raw = await readFile(file, 'utf8')
  if (isPatched(raw)) {
    console.log(`${MODEL_ID} is already in the catalog; nothing to do`)
    console.log(`  ${file}`)
    return
  }

  const next = patchCatalog(raw)
  // Refuse to write anything that is not valid JSON — a broken catalog would
  // take down every route the engine loads from it, not just this model.
  let parsed
  try {
    parsed = JSON.parse(next)
  } catch (error) {
    console.error(`refusing to write: the patched catalog is not valid JSON (${error.message})`)
    process.exitCode = 1
    return
  }
  const flat = Object.assign({}, ...Object.values(parsed))
  const ids = Object.keys(flat)
  if (ids[0] !== MODEL_ID) {
    console.error(`refusing to write: expected ${MODEL_ID} first, got ${ids[0]}`)
    process.exitCode = 1
    return
  }

  if (dryRun) {
    console.log(`dry run: would insert ${MODEL_ID} into`)
    console.log(`  ${file}`)
    console.log(`  ${Object.keys(flat).length} models after the patch, first = ${ids[0]}`)
    console.log(`  bytes ${raw.length} -> ${next.length}`)
    return
  }

  // Keep the pristine file once: a second run must not overwrite the backup
  // with an already-patched copy.
  const backup = `${file}.bak`
  if (!existsSync(backup)) await copyFile(file, backup)
  await writeFile(file, next, 'utf8')
  console.log(`patched: ${MODEL_ID} is now the first model of opencode-go`)
  console.log(`  ${file}`)
  console.log(`  backup: ${backup}`)
  console.log(`  ${Object.keys(flat).length} models, first = ${ids[0]}`)
  console.log('restart DSH Desktop for the catalog to be re-read')
}

// Only run when invoked directly, so the pure helpers stay importable by tests.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
