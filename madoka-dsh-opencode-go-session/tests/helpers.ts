import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PluginContext } from '../src/index.js'

/** 测试用 ctx：只实现 apply() 实际碰到的部分。 */
export interface TestContext extends PluginContext {
  listeners: Map<string, Array<(...args: any[]) => any>>
  cleanups: unknown[]
}

export function fakeCtx(): TestContext {
  const listeners = new Map<string, Array<(...args: any[]) => any>>()
  const cleanups: unknown[] = []
  const ctx: TestContext = {
    listeners,
    cleanups,
    logger: { info() {}, warn() {}, error() {} },
    effect(fn: () => unknown) {
      const cleanup = fn()
      cleanups.push(cleanup)
      return () => {
        if (typeof cleanup === 'function') (cleanup as () => void)()
      }
    },
    on(name: string, listener: (...args: any[]) => any) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        const i = current.indexOf(listener)
        if (i >= 0) current.splice(i, 1)
      }
    },
  }
  return ctx
}

export function streamListener(ctx: TestContext): (...args: any[]) => any {
  const listeners = ctx.listeners.get('llm/stream')
  if (listeners === undefined || listeners.length === 0) {
    throw new Error('llm/stream listener was not registered')
  }
  return listeners[0]!
}

/** 回显请求头/URL 的本地 HTTP 服务器（无外部网络）。 */
export function echoServer(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ url: req.url, headers: req.headers, body }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('echo server has no port')
      }
      resolve({ server, url: `http://127.0.0.1:${(address as AddressInfo).port}` })
    })
  })
}
