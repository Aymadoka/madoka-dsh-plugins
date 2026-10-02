import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

const EXPECTED_URL = 'https://api.githubcopilot.com/mcp/'
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

function bundleFile(name: string): URL {
  return new URL(`../../${name}`, import.meta.url)
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(bundleFile(name), 'utf8'))
}

describe('manifest', () => {
  it('declares the bundle patch that exists on disk', () => {
    const manifest = readJson('package.json') as {
      name?: unknown
      version?: unknown
      dsh?: { bundle?: { patch?: unknown } }
    }
    assert.equal(manifest.name, 'madoka-dsh-github-mcp')
    assert.ok(typeof manifest.version === 'string' && manifest.version.length > 0)
    assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
    assert.ok(existsSync(bundleFile('cordis.patch.yml')), 'cordis.patch.yml must exist')
  })

  it('ships display metadata in en + zh', () => {
    for (const locale of ['locale/en.json', 'locale/zh.json']) {
      const doc = readJson(locale) as { meta?: { title?: unknown; description?: unknown } }
      assert.ok(
        typeof doc.meta?.title === 'string' && doc.meta.title.length > 0,
        `${locale} needs meta.title`,
      )
      assert.ok(
        typeof doc.meta?.description === 'string' && doc.meta.description.length > 0,
        `${locale} needs meta.description`,
      )
    }
  })
})

describe('docs', () => {
  it('README documents the DSH-side override contract', () => {
    const readme = readFileSync(bundleFile('README.md'), 'utf8')
    assert.ok(readme.includes('madoka-github-mcp'), 'override snippet must use the same row id')
    assert.ok(readme.includes('Authorization'), 'override snippet must show the headers field')
    assert.ok(
      readme.includes('整体替换'),
      'README must state that an override replaces the complete config',
    )
  })
})

describe('cordis.patch.yml', () => {
  it('references the token via env var and never hardcodes one', () => {
    const raw = readFileSync(bundleFile('cordis.patch.yml'), 'utf8')
    assert.ok(
      raw.includes('process.env.GITHUB_PERSONAL_ACCESS_TOKEN'),
      'Authorization must reference GITHUB_PERSONAL_ACCESS_TOKEN via !!js',
    )
    assert.match(raw, /!!js/, 'Authorization header must use a Loader !!js expression')
    assert.doesNotMatch(raw, /gh[pous]_[A-Za-z0-9_]+/, 'no classic PAT may appear in the patch')
    assert.doesNotMatch(raw, /github_pat_[A-Za-z0-9_]+/, 'no fine-grained PAT may appear in the patch')
  })

  it('inserts exactly the GitHub bridge row', () => {
    const raw = readFileSync(bundleFile('cordis.patch.yml'), 'utf8')
    // The !!js Loader expression is evaluated by the host, not by YAML parsers:
    // stub it out so the structural check below only sees plain YAML.
    const sanitized = raw.replace(/^(\s*Authorization:\s*)!!js.*$/gm, '$1STUBBED')
    const patch = parseYaml(sanitized) as Array<{
      insert?: Array<{
        id?: unknown
        name?: unknown
        config?: {
          serverName?: unknown
          transport?: unknown
          url?: unknown
          headers?: unknown
          failOnStartupError?: unknown
        }
      }>
    }>
    assert.ok(Array.isArray(patch))
    const rows = patch.flatMap((op) => op.insert ?? [])
    assert.equal(rows.length, 2)
    const row = rows.find((r) => r?.id === 'madoka-github-mcp')
    assert.ok(row, 'bridge row madoka-github-mcp must exist')
    assert.equal(row.name, '@deepseek-ai/dsh-mcp-client')

    const config = row.config
    assert.ok(config, 'bridge row needs config')
    assert.equal(config.serverName, 'github')
    assert.ok(
      typeof config.serverName === 'string' && SERVER_NAME_RE.test(config.serverName),
      'serverName must match [A-Za-z0-9_-]{1,32}',
    )
    assert.equal(config.transport, 'streamable-http')
    const url = new URL(String(config.url))
    assert.equal(url.href, EXPECTED_URL)
    assert.equal(url.protocol, 'https:')
    assert.ok(config.headers !== undefined, 'remote GitHub MCP requires an Authorization header')
    assert.equal(config.failOnStartupError, true)
  })

  it('mounts the token config page on its own row', () => {
    const raw = readFileSync(bundleFile('cordis.patch.yml'), 'utf8')
    const sanitized = raw.replace(/^(\s*Authorization:\s*)!!js.*$/gm, '$1STUBBED')
    const patch = parseYaml(sanitized) as Array<{ insert?: Array<{ id?: unknown; name?: unknown }> }>
    const rows = patch.flatMap((op) => op.insert ?? [])
    const mount = rows.find((r) => r?.id === 'madoka-github-mcp-config')
    assert.ok(mount, 'config page mount row must exist')
    assert.equal(mount.name, 'madoka-dsh-github-mcp')

    const client = readFileSync(bundleFile('client.js'), 'utf8')
    assert.ok(client.includes('__ModuleLoader__'), 'client.js must use the browser module format')
    assert.ok(
      client.includes('madoka-dsh-github-mcp#madoka-github-mcp'),
      'client.js must target the bridge row config slot',
    )
    assert.ok(client.includes('plugins.row.config'), 'client.js must register plugins.row.config')
    assert.ok(!client.includes('ghp_') && !client.includes('github_pat_'),
      'client.js must not contain token literals')
    assert.ok(existsSync(bundleFile('index.js')), 'index.js mount row module must exist')
  })

  it('declares the browser half in the manifest', () => {
    const manifest = readJson('package.json') as {
      main?: unknown
      exports?: Record<string, unknown>
      files?: unknown
      dsh?: { client?: { platform?: unknown; immediately?: unknown }; manifestVersion?: unknown }
    }
    assert.equal(manifest.main, './index.js')
    assert.ok(manifest.exports?.['./client'] !== undefined, 'package needs a ./client export')
    assert.ok(
      Array.isArray(manifest.files) && manifest.files.includes('client.js'),
      'client.js must ship in files',
    )
    assert.equal(manifest.dsh?.client?.platform, 'web')
    // Without manifestVersion the host ignores dsh.client entirely (the token
    // form then never mounts — seen live as "该行当前无法配置"). Mirrors the
    // working third-party bundle dsh-better-sidebar, which also omits the
    // template-only `immediately` flag.
    assert.equal(manifest.dsh?.manifestVersion, 1)
    assert.equal(manifest.dsh?.client?.immediately, undefined)
  })
})
