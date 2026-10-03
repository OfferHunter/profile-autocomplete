/**
 * Test harness for the form-filler plugin: a real `ws` client that plays the
 * browser extension — it dials the bridge, completes the `hello`/`ready`
 * handshake, publishes tabs, and answers `command` messages with scripted
 * results. Everything else in the pipeline is the production code.
 * @module @deepseek-ai/dsh-experimental-form-filler/tests/harness
 */

import { createServer } from 'node:http'
import { WebSocket, type RawData } from 'ws'

/** Decode one WebSocket frame payload to text (mirrors the gateway's decode). */
function frameText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
  return Buffer.from(raw).toString('utf8')
}

/** One `command` message the bridge sent to the extension. */
export interface CommandMessage {
  type: 'command'
  id: string
  op: string
  [key: string]: unknown
}

/** The reply a scripted extension handler produces for one command. */
export type CommandReply =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

/** A live fake-extension connection. */
export interface FakeExtension {
  readonly browser: string
  /** Every message received, in order (commands, pings, cancels). */
  readonly received: Array<Record<string, unknown>>
  readonly commands: CommandMessage[]
  /** Resolve once at least `count` commands have been answered. */
  waitForCommands(count: number): Promise<void>
  close(): Promise<void>
}

/** A port the OS just handed out and released; good enough for a test listener. */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => { resolve(port) })
    })
  })
}

/** Connect a fake extension and complete its handshake. */
export async function connectExtension(options: {
  port: number
  browser: string
  tabs?: Array<{ id: number; url: string; title: string }>
  origin?: string
  respond: (command: CommandMessage) => CommandReply | Promise<CommandReply>
}): Promise<FakeExtension> {
  const socket = new WebSocket(`ws://127.0.0.1:${options.port}/bridge`, {
    ...options.origin === undefined ? {} : { origin: options.origin },
  })
  const received: Array<Record<string, unknown>> = []
  const commands: CommandMessage[] = []
  const watchers: Array<{ count: number | undefined; type: string | undefined; resolve: () => void }> = []
  let ready = false

  const settle = (): void => {
    for (const watcher of [...watchers]) {
      const satisfied = (watcher.type === undefined || received.some(message => message.type === watcher.type))
        && (watcher.count === undefined || commands.length >= watcher.count)
      if (!satisfied) continue
      watchers.splice(watchers.indexOf(watcher), 1)
      watcher.resolve()
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    socket.once('error', onError)
    socket.on('message', (raw) => {
      const message = JSON.parse(frameText(raw)) as Record<string, unknown>
      received.push(message)
      if (!ready) {
        if (message.type !== 'ready') return
        ready = true
        socket.off('error', onError)
        resolve()
        return
      }
      if (message.type === 'command') {
        const command = message as CommandMessage
        commands.push(command)
        settle()
        // A handler may defer its reply, letting a test exercise the command deadline.
        Promise.resolve(options.respond(command)).then((reply) => {
          if (socket.readyState !== WebSocket.OPEN) return
          socket.send(JSON.stringify(reply.ok
            ? { type: 'result', id: command.id, ok: true, result: reply.result }
            : { type: 'result', id: command.id, ok: false, error: reply.error }))
        }, () => { /* a rejected handler drops the reply; the caller times out */ })
      }
      settle()
    })
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'hello', browser: options.browser }))
    })
  })

  socket.send(JSON.stringify({ type: 'tabs', tabs: options.tabs ?? [] }))

  const extension: FakeExtension = {
    browser: options.browser,
    received,
    commands,
    waitForCommands(count: number): Promise<void> {
      if (commands.length >= count) return Promise.resolve()
      return new Promise<void>((resolve) => {
        watchers.push({ count, type: undefined, resolve })
        settle()
      })
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        socket.once('close', () => { resolve() })
        socket.close()
      })
    },
  }

  // The bridge answers `ping` after handling everything already queued, so a
  // pong proves the tab list has been absorbed before the first tool call.
  socket.send(JSON.stringify({ type: 'ping' }))
  await new Promise<void>((resolve) => {
    watchers.push({ count: undefined, type: 'pong', resolve })
    settle()
  })

  return extension
}
