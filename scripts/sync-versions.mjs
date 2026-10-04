// Workspace version authority: the root package.json `version` is the single
// lockstep version for every plugin below. `sync` writes it into each member
// manifest; `bump <patch|minor|major>` bumps the root first, then syncs;
// `check` fails (non-zero exit) when any member drifts, so `precheck` keeps
// the suite unified on every `npm run check`.
//
// Formatting is preserved on purpose: every member manifest is 2-space JSON
// with a trailing newline, and this script rewrites exactly that shape
// (key order untouched, no other field modified).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MEMBERS = [
  'madoka-dsh-git-check',
  'madoka-dsh-opencode-go-session',
  'madoka-dsh-microsoft-docs',
  'madoka-dsh-github-mcp',
]

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function rootVersion() {
  const version = readJson(join(ROOT, 'package.json')).version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`root package.json has no usable version: ${String(version)}`)
  }
  return version
}

function sync() {
  const version = rootVersion()
  for (const member of MEMBERS) {
    const path = join(ROOT, member, 'package.json')
    const raw = readFileSync(path, 'utf8')
    const manifest = JSON.parse(raw)
    const before = manifest.version
    if (before === version) {
      console.log(`= ${member} already at ${version}`)
      continue
    }
    manifest.version = version
    const newline = raw.endsWith('\n') ? '\n' : ''
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}${newline}`)
    console.log(`* ${member}: ${before} -> ${version}`)
  }
  console.log(`done: workspace synced to ${version}`)
}

function check() {
  const version = rootVersion()
  const drifted = []
  for (const member of MEMBERS) {
    const manifest = readJson(join(ROOT, member, 'package.json'))
    if (manifest.version === version) {
      console.log(`= ${member} ok (${version})`)
    } else {
      console.log(`x ${member} is ${manifest.version}, want ${version}`)
      drifted.push(member)
    }
  }
  if (drifted.length > 0) {
    throw new Error(`version drift in: ${drifted.join(', ')} (run: npm run version:sync)`)
  }
  console.log(`done: all ${MEMBERS.length} packages at ${version}`)
}

function bump(kind) {
  if (!['patch', 'minor', 'major'].includes(kind)) {
    throw new Error(`usage: node scripts/sync-versions.mjs bump <patch|minor|major>`)
  }
  const [major, minor, patch] = rootVersion().split('.').map(Number)
  const next =
    kind === 'major' ? `${major + 1}.0.0`
    : kind === 'minor' ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`
  const path = join(ROOT, 'package.json')
  const raw = readFileSync(path, 'utf8')
  const manifest = JSON.parse(raw)
  manifest.version = next
  const newline = raw.endsWith('\n') ? '\n' : ''
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}${newline}`)
  console.log(`* root bumped to ${next}`)
  sync()
}

const [command, arg] = process.argv.slice(2)
if (command === 'sync') sync()
else if (command === 'check') check()
else if (command === 'bump') bump(arg)
else throw new Error(`usage: node scripts/sync-versions.mjs <sync|check|bump <patch|minor|major>>`)
