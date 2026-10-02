import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

const EXPECTED_URL = 'https://learn.microsoft.com/api/mcp'
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
    assert.equal(manifest.name, 'madoka-dsh-microsoft-docs')
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

describe('cordis.patch.yml', () => {
  it('inserts exactly the Microsoft Learn bridge row', () => {
    const patch = parseYaml(readFileSync(bundleFile('cordis.patch.yml'), 'utf8')) as Array<{
      insert?: Array<{
        id?: unknown
        name?: unknown
        config?: {
          serverName?: unknown
          transport?: unknown
          url?: unknown
          failOnStartupError?: unknown
        }
      }>
    }>
    assert.ok(Array.isArray(patch))
    const rows = patch.flatMap((op) => op.insert ?? [])
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.ok(row)
    assert.equal(row.id, 'madoka-microsoft-docs')
    assert.equal(row.name, '@deepseek-ai/dsh-mcp-client')

    const config = row.config
    assert.ok(config, 'bridge row needs config')
    assert.equal(config.serverName, 'microsoft-docs')
    assert.ok(
      typeof config.serverName === 'string' && SERVER_NAME_RE.test(config.serverName),
      'serverName must match [A-Za-z0-9_-]{1,32}',
    )
    assert.equal(config.transport, 'streamable-http')
    const url = new URL(String(config.url))
    assert.equal(url.href, `${EXPECTED_URL}`)
    assert.equal(url.protocol, 'https:')
    assert.equal(config.failOnStartupError, true)
  })
})
