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
import { ContextMemory } from '../src/context-memory.ts'
import { ImageMemory } from '../src/image-memory.ts'
import { registerTools } from '../src/tools.ts'
import { connectExtension, freePort, type CommandMessage, type FakeExtension } from './harness.ts'

const TAB = { id: 7, url: 'https://jobs.example.com/apply', title: '在线申请' }
const PNG = 'iVBORw0KGgo='
const CLIP = { x: 0, y: 0, width: 800, height: 600 }

/** A minimal session stub: the image memory keys on `id` and scans `surface.nodes`. */
const SESSION = { id: 'session-a', surface: { nodes: [] as number[] } }

const FRAME0 = {
  frameId: 0, documentId: 'top-doc-1', frameUrl: TAB.url, title: TAB.title,
  html: '<html><body><input id="name"></body></html>', nodes: 2, error: null,
}
const FRAME1 = {
  frameId: 1, documentId: 'frame-doc-1', frameUrl: 'https://jobs.example.com/embed', title: '子框架',
  html: '<html><body><input id="inner"></body></html>', nodes: 2, error: null,
}

let root: string | undefined
let context: Context | undefined
let bridge: Bridge | undefined
let extension: FakeExtension | undefined
let memory: ImageMemory | undefined
let callCounter = 0
let observeImage = PNG
let shotImage = PNG
let observeFrames: unknown[] = [FRAME0]
let actReply: { ok: true; result: unknown } | { ok: false; error: string } = { ok: true, result: { ok: true } }

const observeResult = () => ({
  url: TAB.url,
  title: TAB.title,
  document: 'top-doc-1',
  snapshot: 'snap-1',
  frames: observeFrames,
  image: observeImage,
  clip: CLIP,
  pageHeight: 1200,
})

/** The `scan` reply one frame returns: one control with a label-for candidate. */
const scanResults = () => ({
  ok: true, frameUrl: TAB.url, title: TAB.title, total: 1, offset: 0, count: 1,
  controls: [{
    n: 3, tag: 'input', type: 'text', value: '',
    flags: { visible: true, disabled: false, readonly: false },
    labels: [{ kind: 'label-for', text: '姓名' }],
  }],
})

const shotResult = () => ({ image: shotImage, clip: CLIP, pageHeight: 1200 })

/** The `record` reply: per-op readbacks plus one frame's added subtree and attribute change. */
const recordResults = () => ({
  ops: [{ ok: true, dispatched: true }],
  frames: [{
    frameId: 0,
    added: [{ n: 12, tag: 'div', html: '<div data-pa-n="12">选项 A</div>' }],
    changed: [{ n: 4, tag: 'input', changes: ['aria-expanded'], html: '<input data-pa-n="4" aria-expanded="true">' }],
    truncated: false,
  }],
})

const attachmentsStub = {
  async saveImage(input: { data: Uint8Array; mediaType: string }) {
    return {
      attachmentId: 'att-1' as never,
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 10,
      height: 20,
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
  memory = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  callCounter = 0
  observeImage = PNG
  shotImage = PNG
  observeFrames = [FRAME0]
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
  memory = new ImageMemory('form-filler', { cropSlotSize: 20 })
  const contextMemory = new ContextMemory('form-filler')
  registerTools(context, { bridge: instance, runDir: join(root, 'runs'), memory, contextMemory })

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
      if (command.op === 'act') {
        const call = (command as { call?: { op?: string; items?: Array<{ n: number; value: string }> } }).call
        if (call?.op === 'scan') return { ok: true, result: scanResults() }
        if (call?.op === 'record') return { ok: true, result: recordResults() }
        if (call?.op === 'fill_many') {
          return {
            ok: true,
            result: { ok: true, results: (call.items ?? []).map(item => ({ n: item.n, ok: true, actual: { value: item.value } })) },
          }
        }
        return actReply
      }
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
    agent: (options.agent ?? { session: SESSION }) as never,
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
  it('routes every screenshot into the image memory instead of the tool result', async () => {
    await boot({ attachments: true })
    await attachAndObserve()

    // A full-page observe occupies the full slot, never the crop ring, and
    // reports the id it recorded (attachAndObserve already took id 1).
    expect(memory!.summary(SESSION as never)).toEqual({ full: 1, crops: 0 })
    const observed = value(await call('form_observe', {}))
    expect(observed).not.toHaveProperty('image')
    expect(observed.imageId).toBe(2)

    // form_look records a crop and reports its id.
    expect(value(await call('form_look', { n: 3 })).imageId).toBe(3)
    expect(memory!.summary(SESSION as never)).toEqual({ full: 1, crops: 1 })

    // An empty image payload records nothing and reports no id.
    shotImage = ''
    expect(value(await call('form_look', { n: 3 }))).not.toHaveProperty('imageId')
    expect(memory!.summary(SESSION as never)).toEqual({ full: 1, crops: 1 })
    shotImage = PNG

    // A fill crops a confirmation shot by default and reports its id; it skips
    // both the shot and the id on confirm:false.
    expect(value(await call('form_fill', { n: 3, value: '张三' })).imageId).toBe(4)
    expect(memory!.summary(SESSION as never).crops).toBe(2)
    expect(value(await call('form_fill', { n: 3, value: '张三', confirm: false }))).not.toHaveProperty('imageId')
    expect(memory!.summary(SESSION as never).crops).toBe(2)

    // form_type crops around n when given, and never without one.
    await call('form_type', { text: '张', n: 3 })
    expect(memory!.summary(SESSION as never).crops).toBe(3)
    await call('form_type', { text: '张' })
    expect(memory!.summary(SESSION as never).crops).toBe(3)

    // form_click mirrors fill: crops on success, counts attempts on failure.
    await call('form_click', { n: 5 })
    expect(memory!.summary(SESSION as never).crops).toBe(4)
    actReply = { ok: true, result: { ok: false, reason: 'no-op' } }
    expect(value(await call('form_click', { n: 5, frame: 2 }))).toMatchObject({ attempts: 1, ok: false })
    expect(memory!.summary(SESSION as never).crops).toBe(4)
  })

  it('drop_images releases recorded images by id and reports what remains', async () => {
    await boot({ attachments: true })
    await attachAndObserve()
    await call('form_look', { n: 3 })
    await call('form_fill', { n: 3, value: '张三' })

    // Ids are handed out in record order: full-page 1, look crop 2, fill crop 3.
    expect(value(await call('drop_images', { ids: [2] })))
      .toEqual({ dropped: 1, remaining: { full: 1, crops: 1 } })
    // Dropping an id nothing holds is a no-op.
    expect(value(await call('drop_images', { ids: [99] })))
      .toEqual({ dropped: 0, remaining: { full: 1, crops: 1 } })
    // The full-page shot is droppable too.
    expect(value(await call('drop_images', { ids: [1, 3] })))
      .toEqual({ dropped: 2, remaining: { full: 0, crops: 0 } })
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

  it('form_scan walks every observed frame and merges per-frame controls', async () => {
    await boot()
    await call('form_attach', { tabId: 7 })
    observeFrames = [FRAME0, FRAME1]
    await call('form_observe', {})

    const scanned = value(await call('form_scan', {}))
    const frames = scanned.frames as Array<{ frameId: number; controls: Array<Record<string, unknown>> }>
    expect(frames.map(frame => frame.frameId)).toEqual([0, 1])
    expect(frames[0].controls[0]).toMatchObject({ n: 3, tag: 'input' })
    expect(frames[1].controls).toHaveLength(1)

    // One scan command per frame.
    const scans = extension!.commands.filter(
      command => command.op === 'act' && (command as { call?: { op?: string } }).call?.op === 'scan',
    )
    expect(scans).toHaveLength(2)

    // An explicit frame scans only that one.
    const one = value(await call('form_scan', { frame: 1 }))
    expect((one.frames as Array<{ frameId: number }>).map(frame => frame.frameId)).toEqual([1])
  })

  it('form_fill_batch groups by frame and returns per-item readbacks', async () => {
    await boot()
    await attachAndObserve()

    const res = value(await call('form_fill_batch', {
      items: [
        { n: 1, value: '张三' },
        { n: 2, value: 'true', frame: 1 },
        { n: 3, value: '李四' },
      ],
    }))
    const results = res.results as Array<Record<string, unknown>>
    expect(results).toHaveLength(3)
    expect(results.every(item => item.ok === true)).toBe(true)
    // Grouped by first-seen frame: frame 0 keeps document order, then frame 1.
    expect(results.map(item => [item.frame, item.n])).toEqual([[0, 1], [0, 3], [1, 2]])

    // One command per frame, not per item.
    const batched = extension!.commands.filter(
      command => command.op === 'act' && (command as { call?: { op?: string } }).call?.op === 'fill_many',
    )
    expect(batched).toHaveLength(2)

    // A batch-level frame defaults every item that omits its own; an item's own
    // frame wins. Grouping still goes by first-seen frame.
    const mixed = value(await call('form_fill_batch', {
      frame: 1,
      items: [
        { n: 4, value: '王五', frame: 0 },
        { n: 5, value: '赵六' },
      ],
    }))
    expect((mixed.results as Array<Record<string, unknown>>).map(item => [item.frame, item.n]))
      .toEqual([[0, 4], [1, 5]])
    const mixedFrames = extension!.commands
      .filter(command => command.op === 'act' && (command as { call?: { op?: string } }).call?.op === 'fill_many')
      .slice(2)
      .map(command => (command as { call: { frame: number } }).call.frame)
    expect(mixedFrames).toEqual([0, 1])
  })

  it('form_record_mutation forwards a batch and returns the per-frame diff', async () => {
    await boot()
    await attachAndObserve()

    const res = value(await call('form_record_mutation', {
      ops: [{ op: 'click', n: 4, trusted: true }],
      settleMs: 150,
    }))
    const frames = res.frames as Array<{ frameId: number; added: Array<{ n: number }>; changed: Array<{ n: number }> }>
    expect(frames[0].frameId).toBe(0)
    expect(frames[0].added[0].n).toBe(12)
    expect(frames[0].changed[0].n).toBe(4)

    // The batch rides one `record` command whose call carries the ops and the window.
    const records = extension!.commands.filter(
      command => command.op === 'act' && (command as { call?: { op?: string } }).call?.op === 'record',
    )
    expect(records).toHaveLength(1)
    const sent = (records[0] as { call: { ops: Array<{ op: string; n: number; trusted: boolean; frame: number }>; settleMs: number } }).call
    expect(sent.ops[0]).toMatchObject({ op: 'click', n: 4, trusted: true, frame: 0 })
    expect(sent.settleMs).toBe(150)
  })
})
