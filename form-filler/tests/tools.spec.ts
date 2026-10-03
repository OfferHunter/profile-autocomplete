/**
 * Tool-level branches the composition test leaves dark: the image path (with a
 * stub attachment store), the click/attach/wait edge cases, and the per-session
 * binding derived from an agent-less call. The bridge and the `ws` client are
 * real; only the browser and the attachment store are faked.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Bridge } from '../src/bridge.ts'
import { registerTools } from '../src/tools.ts'
import { connectExtension, freePort, type CommandMessage, type FakeExtension } from './harness.ts'

const TAB = { id: 7, url: 'https://jobs.example.com/apply', title: '在线申请' }
const PNG = 'iVBORw0KGgo='
const CLIP = { x: 0, y: 0, width: 800, height: 600 }

let root: string | undefined
let context: Context | undefined
let bridge: Bridge | undefined
let extension: FakeExtension | undefined
let callCounter = 0
let stubName: string | undefined = 'stub.png'
let observeImage = PNG
let shotImage = PNG
let actReply: { ok: true; result: unknown } | { ok: false; error: string } = { ok: true, result: { ok: true } }

const observeResult = () => ({
  url: TAB.url,
  title: TAB.title,
  document: 'top-doc-1',
  snapshot: 'snap-1',
  frames: [{
    frameId: 0, documentId: 'top-doc-1', frameUrl: TAB.url, title: TAB.title,
    html: '<html><body><input id="name"></body></html>', nodes: 2, error: null,
  }],
  image: observeImage,
  clip: CLIP,
  pageHeight: 1200,
})

const shotResult = () => ({ image: shotImage, clip: CLIP, pageHeight: 1200 })

const attachmentsStub = {
  async saveImage(input: { data: Uint8Array; mediaType: string }) {
    return {
      attachmentId: 'att-1' as never,
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 10,
      height: 20,
      ...stubName === undefined ? {} : { name: stubName },
    } as never
  },
}

afterEach(async () => {
  await extension?.close()
  extension = undefined
  await context?.fiber.dispose()
  context = undefined
  await bridge?.stop()
  bridge = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  callCounter = 0
  stubName = 'stub.png'
  observeImage = PNG
  shotImage = PNG
  actReply = { ok: true, result: { ok: true } }
})

/** Boot ToolRuntime + the form-filler tools against a real bridge and fake browser. */
async function boot(options: { attachments?: boolean; observeDelayMs?: number } = {}): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'dsh-form-filler-tools-'))
  const port = await freePort()
  const instance = new Bridge({ host: '127.0.0.1', port })
  await instance.start()
  bridge = instance

  context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  if (options.attachments === true) context.provide('attachments', attachmentsStub)
  registerTools(context, { bridge: instance, runDir: join(root, 'runs') })

  extension = await connectExtension({
    port, browser: 'browser-a', tabs: [TAB],
    respond: (command: CommandMessage) => {
      if (command.op === 'observe') {
        const reply: { ok: true; result: unknown } = { ok: true, result: observeResult() }
        const delayMs = options.observeDelayMs
        return delayMs === undefined
          ? reply
          : new Promise<{ ok: true; result: unknown }>((resolve) => { setTimeout(() => { resolve(reply) }, delayMs) })
      }
      if (command.op === 'shot') return { ok: true, result: shotResult() }
      if (command.op === 'act') return actReply
      return { ok: false, error: `unexpected op ${command.op}` }
    },
  })
}

function call(name: string, args: unknown, options: { agent?: unknown; signal?: AbortSignal } = {}) {
  return context!.tools.execute({
    signal: options.signal ?? new AbortController().signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: (options.agent ?? { session: { id: 'session-a' } }) as never,
  })
}

function value(result: { value?: unknown }): Record<string, unknown> {
  return result.value as Record<string, unknown>
}

async function attachAndObserve(): Promise<void> {
  await call('form_attach', { tabId: 7 })
  await call('form_observe', {})
}

describe('form-filler tools with an attachment store', () => {
  it('carries saved images through observe, look, fill, type, and click', async () => {
    await boot({ attachments: true })
    await attachAndObserve()

    const observed = await call('form_observe', {})
    const observedImage = value(observed).image as Record<string, unknown>
    expect(observedImage).toEqual({
      attachmentId: 'att-1', mediaType: 'image/png', bytes: 8, width: 10, height: 20, name: 'stub.png',
    })

    // A saveImage whose ref carries no name omits it from the image value.
    stubName = undefined
    const looked = await call('form_look', { n: 3 })
    expect(value(looked).image).toEqual({ attachmentId: 'att-1', mediaType: 'image/png', bytes: 8, width: 10, height: 20 })

    // An empty image payload is dropped entirely.
    stubName = 'stub.png'
    shotImage = ''
    expect(value(await call('form_look', { n: 3 })).image).toBeUndefined()
    shotImage = PNG

    // A fill crops a confirmation shot by default and skips it on confirm:false.
    expect(value(await call('form_fill', { n: 3, value: '张三' })).image).toBeDefined()
    expect(value(await call('form_fill', { n: 3, value: '张三', confirm: false })).image).toBeUndefined()

    // form_type crops around n when given, and never without one.
    expect(value(await call('form_type', { text: '张', n: 3 })).image).toBeDefined()
    expect(value(await call('form_type', { text: '张' })).image).toBeUndefined()

    // form_click mirrors fill: image by default, attempts only on failure.
    expect(value(await call('form_click', { n: 5 })).image).toBeDefined()
    actReply = { ok: true, result: { ok: false, reason: 'no-op' } }
    expect(value(await call('form_click', { n: 5, frame: 2 }))).toMatchObject({ attempts: 1, ok: false })
  })

  it('handles attach mismatches, agent-less sessions, frames, and aborts', async () => {
    await boot()

    const mismatched = await call('form_attach', { tabId: 7, browser: 'browser-z' })
    expect(mismatched.isError).toBe(true)

    // An explicit frame and an explicit matching browser both take the happy path.
    await call('form_attach', { tabId: 7, browser: 'browser-a' })
    await call('form_observe', {})

    // No agent attached: the binding falls back to the shared 'default' session.
    expect(value(await call('form_tabs', {}, { agent: {} })).browsers).toBeDefined()

    // frame: undefined defaults to 0; an explicit frame is passed through.
    expect(value(await call('form_read', { n: 3 })).ok).toBe(true)
    expect(value(await call('form_read', { n: 3, frame: 2 })).ok).toBe(true)

    // form_type rejects empty text and empty key, then proceeds with real text.
    expect((await call('form_type', { text: '' })).isError).toBe(true)
    expect((await call('form_type', { key: '' })).isError).toBe(true)
    expect(value(await call('form_type', { text: '张' })).ok).toBe(true)

    // An abort mid-wait clears the timer and fails the call.
    const aborted = new AbortController()
    const waiting = call('form_wait', { ms: 30_000 }, { signal: aborted.signal })
    await new Promise(resolve => setTimeout(resolve, 20))
    aborted.abort()
    expect((await waiting).isError).toBe(true)
  })

  it('caps the per-call deadline and lets the model raise it past the default', async () => {
    await boot({ observeDelayMs: 150 })
    await call('form_attach', { tabId: 7 })

    // A deadline below the extension's latency times the observation out.
    expect((await call('form_observe', { timeoutMs: 50 })).isError).toBe(true)
    // A generous one covers it, and the call succeeds.
    expect(value(await call('form_observe', { timeoutMs: 5_000 })).snapshotId).toBe('snap-1')
  })

  it('accepts the op-specific readbacks scroll, upload, and a trusted pointer return', async () => {
    await boot()
    await attachAndObserve()

    // scroll reports the resulting document offset; the schema must declare it.
    actReply = { ok: true, result: { ok: true, scrollY: 825 } }
    expect(value(await call('form_scroll', { n: 825 }))).toMatchObject({ ok: true, scrollY: 825 })

    // upload reports the attached paths.
    actReply = { ok: true, result: { ok: true, files: ['C:\\cv.pdf'] } }
    expect(value(await call('form_upload', { n: 9, path: 'C:\\cv.pdf' }))).toMatchObject({ ok: true })

    // A trusted click/hover reports the synthesized pointer position.
    actReply = { ok: true, result: { ok: true, dispatched: true, point: { x: 12, y: 34 } } }
    expect(value(await call('form_click', { n: 5, trusted: true }))).toMatchObject({ ok: true })
    expect(value(await call('form_hover', { n: 5, trusted: true }))).toMatchObject({ ok: true })
  })
})
