/**
 * Bridge edge cases: the HTTP probe faces, request correlation failures,
 * upgrade rejection, and the handshake gate. These drive the real listener and
 * a real `ws` client; only the browser is faked.
 */

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { Bridge } from '../src/bridge.ts'

let root: string
let bridge: Bridge | undefined
const sockets: WebSocket[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-form-filler-bridge-'))
})

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.on('error', () => { /* teardown */ })
    try { socket.terminate() } catch { /* a still-CONNECTING socket cannot terminate */ }
  }
  await bridge?.stop()
  bridge = undefined
  await rm(root, { recursive: true, force: true })
})

/** Start a bridge on an OS-assigned port. */
async function start(overrides: {
  port?: number
  commandTimeoutMs?: number
  helloTimeoutMs?: number
} = {}): Promise<Bridge> {
  const instance = new Bridge({
    host: '127.0.0.1',
    port: overrides.port ?? 0,
    ...overrides.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: overrides.commandTimeoutMs },
    ...overrides.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: overrides.helloTimeoutMs },
  })
  await instance.start()
  bridge = instance
  return instance
}

/** Open a raw WebSocket, optionally with an explicit Origin header. */
function open(port: number, origin?: string): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, origin === undefined ? {} : { origin })
  sockets.push(socket)
  return socket
}

/** Resolve once the socket's connection is established. */
function opened(socket: WebSocket): Promise<void> {
  if (socket.readyState === socket.OPEN) return Promise.resolve()
  return new Promise<void>((resolve) => { socket.once('open', () => { resolve() }) })
}

/** Resolve when `socket` closes, with the close code. */
function closed(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => { socket.once('close', (code) => { resolve(code) }) })
}

/** Read messages until one matches `type`, then resolve with it. */
function next(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (raw: unknown): void => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>
      if (message.type !== type) return
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
  })
}

/** One raw HTTP/Upgrade request; reports how the server answered. */
function rawUpgrade(port: number, path: string, origin?: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const req = httpRequest({
      port, host: '127.0.0.1', path,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...origin === undefined ? {} : { Origin: origin },
      },
    })
    req.on('upgrade', (_response, socket) => { socket.destroy(); resolve('upgraded') })
    req.on('response', (response) => { response.resume(); resolve('response') })
    req.on('error', () => { resolve('destroyed') })
    req.end()
  })
}

/** Complete a handshake and wait for `ready`. */
async function handshake(port: number, browser = 'browser-a', origin?: string): Promise<WebSocket> {
  const socket = open(port, origin)
  await opened(socket)
  const ready = next(socket, 'ready')
  socket.send(JSON.stringify({ type: 'hello', browser }))
  await ready
  return socket
}

describe('Bridge HTTP probe faces', () => {
  it('answers /health and 404s everything else', async () => {
    const instance = await start()
    const health = await fetch(`http://127.0.0.1:${instance.port}/health`)
    expect(health.status).toBe(200)
    expect(await health.text()).toBe('ok')
    const other = await fetch(`http://127.0.0.1:${instance.port}/other`)
    expect(other.status).toBe(404)
  })
})

describe('Bridge request correlation', () => {
  it('refuses an unknown browser and a pre-aborted signal', async () => {
    const instance = await start()
    await expect(instance.request('nobody', 'observe')).rejects.toThrow('浏览器扩展未连接')

    await handshake(instance.port)
    const aborted = new AbortController()
    aborted.abort()
    await expect(instance.request('browser-a', 'observe', {}, aborted.signal)).rejects.toThrow('已取消')
  })

  it('cancels an in-flight command when the signal aborts', async () => {
    const instance = await start()
    const socket = await handshake(instance.port)
    const cancel = next(socket, 'cancel')

    const controller = new AbortController()
    const pending = instance.request('browser-a', 'observe', {}, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('已取消')
    expect((await cancel).type).toBe('cancel')
    // The abort path removed the pending entry: a late reply is ignored.
    socket.send(JSON.stringify({ type: 'result', id: 'whatever', ok: true, result: 1 }))
  })

  it('reports extension-provided errors, empty failures, and late replies', async () => {
    const instance = await start()
    const socket = await handshake(instance.port)

    const first = instance.request('browser-a', 'act')
    const command = await next(socket, 'command')
    socket.send(JSON.stringify({ type: 'result', id: command.id, ok: false, error: '页面执行失败' }))
    await expect(first).rejects.toThrow('页面执行失败')

    const second = instance.request('browser-a', 'act')
    const command2 = await next(socket, 'command')
    socket.send(JSON.stringify({ type: 'result', id: command2.id, ok: false }))
    await expect(second).rejects.toThrow('浏览器命令失败')

    // A result for an unknown id, and a result from another browser, are both ignored.
    socket.send(JSON.stringify({ type: 'result', id: 'no-such-id', ok: true, result: 1 }))
    const third = instance.request('browser-a', 'read')
    const command3 = await next(socket, 'command')
    const other = await handshake(instance.port, 'browser-b')
    other.send(JSON.stringify({ type: 'result', id: command3.id, ok: true, result: 'from-b' }))
    socket.send(JSON.stringify({ type: 'result', id: command3.id, ok: true, result: 'from-a' }))
    expect(await third).toBe('from-a')
  })

  it('times out an unanswered command and tells the extension to cancel', async () => {
    const instance = await start({ commandTimeoutMs: 30 })
    const socket = await handshake(instance.port)

    const pending = instance.request('browser-a', 'observe')
    const cancel = next(socket, 'cancel')
    await expect(pending).rejects.toThrow('浏览器命令超时')
    expect((await cancel).type).toBe('cancel')
  })

  it('lets a per-call deadline override the instance default', async () => {
    // The instance default is far longer than the test budget; only the per-call
    // 30ms deadline can make this reject, so honouring it is what passes.
    const instance = await start({ commandTimeoutMs: 60_000 })
    const socket = await handshake(instance.port)

    const pending = instance.request('browser-a', 'observe', {}, undefined, 30)
    const cancel = next(socket, 'cancel')
    await expect(pending).rejects.toThrow('浏览器命令超时')
    expect((await cancel).type).toBe('cancel')
  })

  it('rejects every pending command when the bridge stops', async () => {
    const instance = await start()
    const socket = await handshake(instance.port)
    const pending = instance.request('browser-a', 'observe')
    const failure = expect(pending).rejects.toThrow('shutting down')
    await next(socket, 'command')
    await instance.stop()
    bridge = undefined
    await failure
    // A second stop is a no-op.
    await expect(instance.stop()).resolves.toBeUndefined()
  })
})

describe('Bridge upgrade gate', () => {
  it('destroys an upgrade on a wrong path or a foreign origin', async () => {
    const instance = await start()
    expect(await rawUpgrade(instance.port, '/nope')).toBe('destroyed')
    expect(await rawUpgrade(instance.port, '/bridge', 'http://evil.example')).toBe('destroyed')
    expect(await rawUpgrade(instance.port, '/bridge', 'chrome-extension://abc')).toBe('upgraded')
  })
})

describe('Bridge handshake gate', () => {
  it('closes a connection that never says hello', async () => {
    const instance = await start({ helloTimeoutMs: 30 })
    const socket = open(instance.port)
    await opened(socket)
    const done = closed(socket)
    expect(await done).toBe(1008)
  })

  it('closes on a non-hello first message and malformed identity fields', async () => {
    const instance = await start()
    const rejected = async (payload: Record<string, unknown>): Promise<number> => {
      const socket = open(instance.port)
      const done = closed(socket)
      await opened(socket)
      socket.send(JSON.stringify(payload))
      return await done
    }

    expect(await rejected({ type: 'ping' })).toBe(1008)
    expect(await rejected({ type: 'hello', browser: 7 })).toBe(1008)
    expect(await rejected({ type: 'hello' })).toBe(1008)
    expect(await rejected({ type: 'hello', browser: '' })).toBe(1008)
    expect(await rejected({ type: 'hello', browser: 'x'.repeat(101) })).toBe(1008)
  })

  it('closes a second connection claiming the same browser identity', async () => {
    const instance = await start()
    await handshake(instance.port, 'dup')
    const second = open(instance.port)
    const done = closed(second)
    await opened(second)
    second.send(JSON.stringify({ type: 'hello', browser: 'dup' }))
    expect(await done).toBe(1008)
  })

  it('ignores malformed frames, non-array tabs, and unknown message types', async () => {
    const instance = await start()
    const socket = await handshake(instance.port)
    socket.send('not json at all')
    socket.send(JSON.stringify({ type: 'tabs', tabs: 'nope' }))
    socket.send(JSON.stringify({ type: 'mystery' }))
    const pong = next(socket, 'pong')
    socket.send(JSON.stringify({ type: 'ping' }))
    await pong
    expect(instance.browsers()).toEqual([{ browser: 'browser-a', tabs: [] }])
  })

  it('survives a frame-level socket error and keeps serving', async () => {
    const instance = await start()
    const socket = await handshake(instance.port)
    socket.on('error', () => { /* the bridge closes the frame on invalid UTF-8 */ })
    // A text frame with invalid UTF-8 makes the server socket emit an error.
    socket.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false })
    await new Promise(resolve => setTimeout(resolve, 50))
    // The listener is still up for a fresh connection.
    await handshake(instance.port, 'browser-b')
  })

  it('forgets a browser whose socket closes', async () => {
    const instance = await start()
    const socket = await handshake(instance.port)
    socket.send(JSON.stringify({ type: 'tabs', tabs: [{ id: 1, url: 'https://a', title: 'a' }] }))
    const pong = next(socket, 'pong')
    socket.send(JSON.stringify({ type: 'ping' }))
    await pong
    expect(instance.findTab(1)?.browser).toBe('browser-a')

    const done = closed(socket)
    socket.close()
    await done
    await vi.waitFor(() => { expect(instance.browsers()).toEqual([]) })
    expect(instance.findTab(1)).toBeUndefined()
  })
})
