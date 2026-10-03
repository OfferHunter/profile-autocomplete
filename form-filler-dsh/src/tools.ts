/**
 * The model-facing form-filling tool set: perception primitives (`form_tabs`,
 * `form_attach`, `form_observe`, `form_look`, `form_read`, `form_scan`) plus
 * action primitives (`form_fill`, `form_fill_batch`, `form_click`, `form_type`,
 * `form_hover`, `form_scroll`, `form_wait`, `form_upload`).
 *
 * Every primitive is deliberately free of local judgement: nothing here decides
 * what counts as a field or whether a control "should" be filled. The snapshot
 * is written to disk verbatim and the model reads the region it cares about;
 * each action returns the browser's readback of the resulting real state.
 * @module @deepseek-ai/dsh-experimental-form-filler/tools
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Bridge, ActResult, ObserveResult, ShotResult } from './bridge.ts'

/** One frame's file index in a `form_observe` result. */
interface FrameIndex {
  frameId: number
  frameUrl: string
  title: string
  path: string
  nodes: number
  error?: string
}

interface ImageValue {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
}

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
} as const

/** The readback fields every element-targeted action shares. */
const ACT_RESULT_PROPERTIES = {
  ok: { type: 'boolean', required: true },
  reason: { type: 'string' },
  message: { type: 'string' },
  dispatched: { type: 'boolean' },
  actual: { type: 'json' },
  box: { type: 'json' },
  matchedOption: {
    type: 'object',
    additionalProperties: false,
    properties: {
      value: { type: 'string', required: true },
      label: { type: 'string', required: true },
    },
  },
  // Op-specific readbacks the extension reports beside `ok`: scroll its resulting
  // document offset, upload the attached paths, a trusted click/hover the
  // synthesized pointer position.
  scrollY: { type: 'integer' },
  files: { type: 'array', items: { type: 'string' } },
  point: {
    type: 'object',
    additionalProperties: false,
    properties: {
      x: { type: 'integer', required: true },
      y: { type: 'integer', required: true },
    },
  },
} as const

const ACT_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ...ACT_RESULT_PROPERTIES },
} as const

const ACT_WITH_IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ...ACT_RESULT_PROPERTIES, image: IMAGE_VALUE_SCHEMA },
} as const

const ACT_WITH_ATTEMPT_AND_IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ...ACT_RESULT_PROPERTIES, attempts: { type: 'integer' }, image: IMAGE_VALUE_SCHEMA },
} as const

const DEFAULT_MAX_WAIT_MS = 30_000

/** Optional per-call override of the bridge command deadline, shared by the bridge-backed tools. */
const TIMEOUT_PARAM = {
  timeoutMs: {
    type: 'integer',
    description: 'Bridge command deadline in milliseconds; raise it for a slow page. Defaults to 30000.',
  },
} as const

/** Caps the model-requested deadline so a stray value cannot stall the agent loop. */
const MAX_TIMEOUT_MS = 120_000

/**
 * Resolve the per-call bridge deadline.
 * @param args - the tool arguments, optionally carrying `timeoutMs`.
 * @returns the capped deadline, or `undefined` to use the bridge's own default.
 */
function requestedTimeout(args: { timeoutMs?: number | undefined }): number | undefined {
  const requested = args.timeoutMs
  if (requested === undefined || requested <= 0) return undefined
  return Math.min(Math.round(requested), MAX_TIMEOUT_MS)
}

/** Per-session target binding, latest observation, and per-action failure counts. */
interface SessionState {
  browser?: string
  tabId?: number
  snapshotId?: string | undefined
  /** The frames of the latest observation, so `form_scan` can walk them. */
  frames?: FrameIndex[]
  attempts: Map<string, number>
}

/** Options resolved once by the plugin and shared by every tool. */
export interface ToolsOptions {
  bridge: Bridge
  /** Snapshot root, relative to the session working directory. */
  runDir: string
}

/** One element-targeted action forwarded to the extension. */
interface ActCall {
  op: string
  frame: number
  n?: number | undefined
  y?: number | undefined
  value?: string | undefined
  path?: string | undefined
  text?: string | undefined
  key?: string | undefined
  trusted?: boolean | undefined
  // `scan` parameters.
  kinds?: string[] | undefined
  maxGapPx?: number | undefined
  maxCandidates?: number | undefined
  scope?: string | undefined
  offset?: number | undefined
  limit?: number | undefined
  // `fill_many` payload.
  items?: Array<{ n: number; value: string }> | undefined
}

/** One control reported by `form_scan` (label kinds are open-ended). */
interface ScannedControl {
  n: number
  tag: string
  labels: Array<{ kind: string; text: string }>
  [key: string]: unknown
}

/** The extension's reply to a `scan` command. */
interface ScanResult {
  frameUrl?: string
  title?: string
  total?: number
  offset?: number
  count?: number
  controls?: ScannedControl[]
  scopeError?: string
}

/** The session identity used to key bindings; falls back when no agent is attached. */
function sessionKey(exec: ToolExecution): string {
  const id = (exec.agent as { session?: { id?: unknown } } | undefined)?.session?.id
  return typeof id === 'string' ? id : 'default'
}

/** Re-brand a stored image value into the durable reference an image block carries. */
function imageRef(value: ImageValue): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(value.attachmentId),
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...value.name === undefined ? {} : { name: value.name },
  }
}

/** Render a value as compact model-facing JSON. */
function json(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Render a value plus an optional confirmation image. */
function jsonWithImage(visible: unknown, image: ImageValue | undefined): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: JSON.stringify(visible) }]
  if (image !== undefined) blocks.push({ type: 'image', attachment: imageRef(image) })
  return blocks
}

/**
 * Register the twelve `form_*` tools on the plugin context.
 * @param ctx - the plugin context carrying `ctx.tools`.
 * @param options - the bridge, the snapshot run directory, and the optional image store.
 */
export function registerTools(ctx: Context, options: ToolsOptions): void {
  const { bridge, runDir } = options
  // The frame index must hand the model absolute paths, so anchor the relative
  // run dir to the session working directory once here.
  const snapshotRoot = resolve(runDir)
  const sessions = new Map<string, SessionState>()

  const stateOf = (exec: ToolExecution): SessionState => {
    const key = sessionKey(exec)
    let state = sessions.get(key)
    if (state === undefined) {
      state = { attempts: new Map() }
      sessions.set(key, state)
    }
    return state
  }

  const targetOf = (exec: ToolExecution): { browser: string; tabId: number; state: SessionState } => {
    const state = stateOf(exec)
    if (state.browser === undefined || state.tabId === undefined) {
      throw new Error('尚未绑定目标标签页；先调用 form_tabs 查看已连接的标签页，再调用 form_attach')
    }
    return { browser: state.browser, tabId: state.tabId, state }
  }

  /** Persist one screenshot as a durable attachment, when a store is mounted. */
  const saveImage = async (base64: string, name: string): Promise<ImageValue | undefined> => {
    const attachments = ctx.get('attachments')
    if (attachments === undefined || base64.length === 0) return undefined
    const ref = await attachments.saveImage({
      data: Buffer.from(base64, 'base64'),
      mediaType: 'image/png',
      name,
    })
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...ref.name === undefined ? {} : { name: ref.name },
    }
  }

  /** Count one failed attempt for the `op@frame:n` key and report the running total. */
  const recordAttempt = (state: SessionState, key: string): number => {
    const next = (state.attempts.get(key) ?? 0) + 1
    state.attempts.set(key, next)
    return next
  }

  const act = async (
    exec: ToolExecution,
    call: ActCall,
    timeoutMs?: number,
  ): Promise<ActResult> => {
    const { browser, tabId, state } = targetOf(exec)
    if (state.snapshotId === undefined) throw new Error('没有可用的页面快照；先调用 form_observe')
    const result = await bridge.request(browser, 'act', {
      tabId, snapshot: state.snapshotId, frame: call.frame, call,
    }, exec.signal, timeoutMs)
    return result as ActResult
  }

  /** Take a targeted confirmation screenshot of one element (Document coordinates). */
  const confirmShot = async (
    exec: ToolExecution,
    frame: number,
    n: number,
    timeoutMs?: number,
  ): Promise<ImageValue | undefined> => {
    const { browser, tabId } = targetOf(exec)
    const shot = await bridge.request(browser, 'shot', {
      tabId, view: { frame, n },
    }, exec.signal, timeoutMs) as ShotResult
    return saveImage(shot.image, `field-${n}.png`)
  }

  ctx.tools.register(defineTool({
    name: 'form_tabs',
    description: 'List the browsers and HTTP(S) tabs currently connected through the form-filling extension, '
      + 'marking the tab this session is already bound to. Call this first, then bind with form_attach.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          browsers: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                browser: { type: 'string', required: true },
                bound: { type: 'boolean', required: true },
                tabs: {
                  type: 'array', required: true,
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      id: { type: 'integer', required: true },
                      url: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => json(value),
    },
    // oxlint-disable-next-line typescript/require-await -- the tool execute contract returns a Promise
    async execute(_args, exec) {
      const state = stateOf(exec)
      return {
        browsers: bridge.browsers().map(entry => ({
          browser: entry.browser,
          bound: state.browser === entry.browser,
          tabs: entry.tabs,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_attach',
    description: 'Bind this session to one browser tab. All later form_* calls act on the bound tab until re-bound. '
      + 'Use the tab id returned by form_tabs.',
    parameters: {
      tabId: { type: 'integer', required: true, description: 'Tab id from form_tabs.' },
      browser: { type: 'string', description: 'Browser identity, when the same tab id is ambiguous.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          browser: { type: 'string', required: true },
          tabId: { type: 'integer', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (_args, value) => json(value),
    },
    // oxlint-disable-next-line typescript/require-await -- the tool execute contract returns a Promise
    async execute(args, exec) {
      const found = bridge.findTab(args.tabId)
      if (found === undefined) throw new Error(`找不到标签页 ${args.tabId}；请重新调用 form_tabs`)
      if (args.browser !== undefined && args.browser !== found.browser) {
        throw new Error(`标签页 ${args.tabId} 属于浏览器 ${found.browser}，不是 ${args.browser}`)
      }
      const state = stateOf(exec)
      state.browser = found.browser
      state.tabId = args.tabId
      state.snapshotId = undefined
      return { browser: found.browser, tabId: args.tabId, url: found.tab.url, title: found.tab.title }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_observe',
    description: 'Observe the bound tab: write every frame\'s complete live DOM to a file and capture a screenshot. '
      + 'Returns a per-frame file index plus an image of the page. Read those files on demand to see labels and options. '
      + 'The snapshot is never truncated, so on a large page read it in ranges (file offset, line limit, grep) rather than all at once. '
      + 'Pass y to look at a lower part of the page, or n (with frame) to crop around one element. '
      + 'Nothing is filtered locally — the snapshot is the real DOM.',
    parameters: {
      y: { type: 'integer', description: 'Document y offset to screenshot from, for content further down.' },
      n: { type: 'integer', description: 'Element address to crop around (with frame).' },
      frame: { type: 'integer', description: 'Frame id for n. Defaults to 0 (top document).' },
      ...TIMEOUT_PARAM,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          documentId: { type: 'string', required: true },
          snapshotId: { type: 'string', required: true },
          pageHeight: { type: 'integer', required: true },
          frames: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                frameId: { type: 'integer', required: true },
                frameUrl: { type: 'string', required: true },
                title: { type: 'string', required: true },
                path: { type: 'string', required: true },
                nodes: { type: 'integer', required: true },
                error: { type: 'string' },
              },
            },
          },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => jsonWithImage({ ...value, image: undefined }, value.image),
    },
    async execute(args, exec) {
      const { browser, tabId, state } = targetOf(exec)
      const observation = await bridge.request(browser, 'observe', {
        tabId, view: { y: args.y, n: args.n, frame: args.frame },
      }, exec.signal, requestedTimeout(args)) as ObserveResult
      state.snapshotId = observation.snapshot

      const dir = join(snapshotRoot, sessionKey(exec), observation.snapshot)
      await mkdir(dir, { recursive: true })
      const frames: FrameIndex[] = []
      for (const frame of observation.frames) {
        const path = join(dir, `frame-${frame.frameId}.html`)
        await writeFile(path, frame.html, 'utf8')
        frames.push({
          frameId: frame.frameId,
          frameUrl: frame.frameUrl,
          title: frame.title,
          path,
          nodes: frame.nodes,
          ...frame.error == null ? {} : { error: frame.error },
        })
      }
      const image = await saveImage(observation.image, 'page.png')
      state.frames = frames
      return {
        url: observation.url,
        title: observation.title,
        documentId: observation.document,
        snapshotId: observation.snapshot,
        pageHeight: observation.pageHeight,
        frames,
        ...image === undefined ? {} : { image },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_look',
    description: 'Screenshot only — no DOM snapshot. Crop around an element (n, with frame) or a document row (y). '
      + 'Cheap; use it to read a label or verify one area without paying for a full observation.',
    parameters: {
      y: { type: 'integer', description: 'Document y offset to screenshot from.' },
      n: { type: 'integer', description: 'Element address to crop around (with frame).' },
      frame: { type: 'integer', description: 'Frame id for n. Defaults to 0.' },
      ...TIMEOUT_PARAM,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          clip: { type: 'object', additionalProperties: true, required: true },
          pageHeight: { type: 'integer', required: true },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => jsonWithImage({ clip: value.clip, pageHeight: value.pageHeight }, value.image),
    },
    async execute(args, exec) {
      const { browser, tabId } = targetOf(exec)
      const shot = await bridge.request(browser, 'shot', {
        tabId, view: { y: args.y, n: args.n, frame: args.frame },
      }, exec.signal, requestedTimeout(args)) as ShotResult
      const image = await saveImage(shot.image, 'look.png')
      return { clip: shot.clip, pageHeight: shot.pageHeight, ...image === undefined ? {} : { image } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_read',
    description: 'Read the current state of one element by address: value, checked state, and the option list for a select. '
      + 'Cheap and non-mutating.',
    parameters: {
      n: { type: 'integer', required: true, description: 'Element address from the snapshot.' },
      frame: { type: 'integer', description: 'Frame id. Defaults to 0.' },
      ...TIMEOUT_PARAM,
    },
    output: {
      schema: ACT_RESULT_SCHEMA,
      render: (_args, value) => json(value),
    },
    async execute(args, exec) {
      return act(exec, { op: 'read', n: args.n, frame: args.frame ?? 0 }, requestedTimeout(args))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_fill',
    description: 'Write a value into a text/textarea/select/radio/checkbox/contenteditable at address n, then read the state back. '
      + 'Refuses when the control already holds a valid value (no override). For a checkbox or radio pass value "true"/"false". '
      + 'For a native select pass the option label or value. A readback mismatch means the site rejected the write.',
    parameters: {
      n: { type: 'integer', required: true, description: 'Element address from the snapshot.' },
      value: { type: 'string', required: true, description: 'The value to write; "true"/"false" for checkbox/radio.' },
      frame: { type: 'integer', description: 'Frame id. Defaults to 0.' },
      confirm: { type: 'boolean', description: 'Crop a confirmation screenshot of the field. Defaults to true.' },
      ...TIMEOUT_PARAM,
    },
    output: {
      schema: ACT_WITH_ATTEMPT_AND_IMAGE_SCHEMA,
      render: (_args, value) => jsonWithImage({ ...value, image: undefined }, value.image),
    },
    async execute(args, exec) {
      const frame = args.frame ?? 0
      const timeoutMs = requestedTimeout(args)
      const result = await act(exec, { op: 'fill', n: args.n, value: args.value, frame }, timeoutMs)
      const state = stateOf(exec)
      const attempts = result.ok ? undefined : recordAttempt(state, `fill:${frame}:${args.n}`)
      const image = result.ok && args.confirm !== false ? await confirmShot(exec, frame, args.n, timeoutMs) : undefined
      return { ...result, ...attempts === undefined ? {} : { attempts }, ...image === undefined ? {} : { image } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_click',
    description: 'Click any element by address: buttons, links, options, custom widgets. '
      + 'A successful dispatch only means the event was sent — verify the result by observing again. '
      + 'Set trusted true to synthesize a real mouse event through the debugger, for controls that ignore DOM clicks.',
    parameters: {
      n: { type: 'integer', required: true, description: 'Element address from the snapshot.' },
      frame: { type: 'integer', description: 'Frame id. Defaults to 0.' },
      trusted: { type: 'boolean', description: 'Use a real (trusted) mouse event via CDP. Defaults to false.' },
      confirm: { type: 'boolean', description: 'Crop a confirmation screenshot. Defaults to true.' },
      ...TIMEOUT_PARAM,
    },
    output: {
      schema: ACT_WITH_ATTEMPT_AND_IMAGE_SCHEMA,
      render: (_args, value) => jsonWithImage({ ...value, image: undefined }, value.image),
    },
    async execute(args, exec) {
      const frame = args.frame ?? 0
      const timeoutMs = requestedTimeout(args)
      const result = await act(exec, { op: 'click', n: args.n, frame, trusted: args.trusted === true }, timeoutMs)
      const state = stateOf(exec)
      const attempts = result.ok ? undefined : recordAttempt(state, `click:${frame}:${args.n}`)
      const image = result.ok && args.confirm !== false ? await confirmShot(exec, frame, args.n, timeoutMs) : undefined
      return { ...result, ...attempts === undefined ? {} : { attempts }, ...image === undefined ? {} : { image } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_type',
    description: 'Focus an element (optional) and send real keystrokes via the debugger: text for autocomplete/date widgets, '
      + 'or one special key (Enter, Tab, Escape, ArrowDown, ArrowUp, Backspace, Delete). '
      + 'Use this when form_fill does not trigger a widget that listens for key events.',
    parameters: {
      n: { type: 'integer', description: 'Element address to focus first.' },
      text: { type: 'string', description: 'Text to type.' },
      key: { type: 'string', description: 'One special key name.' },
      frame: { type: 'integer', description: 'Frame id. Defaults to 0.' },
      confirm: { type: 'boolean', description: 'Crop a confirmation screenshot (needs n). Defaults to true.' },
      ...TIMEOUT_PARAM,
    },
    output: {
      schema: ACT_WITH_IMAGE_SCHEMA,
      render: (_args, value) => jsonWithImage({ ...value, image: undefined }, value.image),
    },
    async execute(args, exec) {
      if ((args.text === undefined || args.text === '') && (args.key === undefined || args.key === '')) {
        throw new Error('form_type 需要 text 或 key 至少一个')
      }
      const frame = args.frame ?? 0
      const timeoutMs = requestedTimeout(args)
      const result = await act(exec, { op: 'type', n: args.n, text: args.text, key: args.key, frame }, timeoutMs)
      const image = args.n !== undefined && args.confirm !== false
        ? await confirmShot(exec, frame, args.n, timeoutMs) : undefined
      return { ...result, ...image === undefined ? {} : { image } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_hover',
    description: 'Hover an element by address, for menus or tooltips that open on hover. '
      + 'Set trusted true to move the real mouse pointer via CDP.',
    parameters: {
      n: { type: 'integer', required: true, description: 'Element address from the snapshot.' },
      frame: { type: 'integer', description: 'Frame id. Defaults to 0.' },
      trusted: { type: 'boolean', description: 'Move a real pointer via CDP. Defaults to false.' },
      ...TIMEOUT_PARAM,
    },
    output: {
      schema: ACT_RESULT_SCHEMA,
      render: (_args, value) => json(value),
    },
    async execute(args, exec) {
      return act(exec, { op: 'hover', n: args.n, frame: args.frame ?? 0, trusted: args.trusted === true }, requestedTimeout(args))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_scroll',
    description: 'Scroll an element into view by address, or scroll the window to document row y.',
    parameters: {
      n: { type: 'integer', description: 'Element address to bring into view.' },
      y: { type: 'integer', description: 'Document y to scroll the window to.' },
      frame: { type: 'integer', description: 'Frame id for n. Defaults to 0.' },
      ...TIMEOUT_PARAM,
    },
    output: {
      schema: ACT_RESULT_SCHEMA,
      render: (_args, value) => json(value),
    },
    async execute(args, exec) {
      if (args.n === undefined && args.y === undefined) throw new Error('form_scroll 需要 n 或 y')
      return act(exec, { op: 'scroll', n: args.n, y: args.y, frame: args.frame ?? 0 }, requestedTimeout(args))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_wait',
    description: 'Wait for AJAX rendering or a controlled component to settle before observing again.',
    parameters: {
      ms: { type: 'integer', required: true, description: 'Milliseconds to wait (capped at 30000).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { waitedMs: { type: 'integer', required: true } },
      },
      render: (_args, value) => json(value),
    },
    async execute(args, exec) {
      const waitedMs = Math.max(0, Math.min(args.ms, DEFAULT_MAX_WAIT_MS))
      const signal = exec.signal
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => { clearTimeout(timer); reject(new Error('已取消')) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, waitedMs)
        /* v8 ignore next -- the runtime refuses an already-aborted signal before the body runs */
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      return { waitedMs }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_upload',
    description: 'Attach a local file to a file input at address n via the debugger. Use an absolute path.',
    parameters: {
      n: { type: 'integer', required: true, description: 'File input address from the snapshot.' },
      path: { type: 'string', required: true, description: 'Absolute path to the file to attach.' },
      frame: { type: 'integer', description: 'Frame id. Defaults to 0.' },
      ...TIMEOUT_PARAM,
    },
    output: {
      schema: ACT_RESULT_SCHEMA,
      render: (_args, value) => json(value),
    },
    async execute(args, exec) {
      return act(exec, { op: 'upload', n: args.n, path: args.path, frame: args.frame ?? 0 }, requestedTimeout(args))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_scan',
    description: 'Enumerate every fillable control on the bound tab — inputs, textareas, selects, contenteditable, '
      + 'and ARIA combobox/listbox/radio/checkbox/switch/textbox/spinbutton — with each control\'s address n, its current '
      + 'state, flags (visible/disabled/readonly), and a set of candidate label texts. Nothing is filtered locally: hidden, '
      + 'file, button, and disabled controls are all listed with flags, so you decide what matters. Each label carries a '
      + '`kind` (label-for, wrapping, aria, dl, legend, table-cell, prev-text, placeholder, title, row-left, above) — you '
      + 'judge which one is the field\'s key. Read it to build the field→value map for form_fill_batch. Requires a prior form_observe.',
    parameters: {
      frame: { type: 'integer', description: 'Frame id to scan. Omit to scan every frame of the latest observation.' },
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label strategies to keep: label-for, wrapping, aria, dl, legend, table-cell, prev-text, placeholder, title, row-left, above. Defaults to all.',
      },
      maxGapPx: { type: 'integer', description: 'Search radius in px for the spatial row-left/above candidates. Defaults to 160.' },
      maxCandidates: { type: 'integer', description: 'Max label candidates per control. Defaults to 6.' },
      scope: { type: 'string', description: 'Optional CSS selector limiting the scan to a subtree.' },
      offset: { type: 'integer', description: 'Skip this many controls (pagination).' },
      limit: { type: 'integer', description: 'Max controls to return. Defaults to 200.' },
      ...TIMEOUT_PARAM,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          frames: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                frameId: { type: 'integer', required: true },
                frameUrl: { type: 'string' },
                title: { type: 'string' },
                total: { type: 'integer' },
                offset: { type: 'integer' },
                count: { type: 'integer' },
                scopeError: { type: 'string' },
                controls: {
                  type: 'array', required: true,
                  items: {
                    type: 'object', additionalProperties: true,
                    properties: {
                      n: { type: 'integer', required: true },
                      tag: { type: 'string', required: true },
                      labels: {
                        type: 'array', required: true,
                        items: {
                          type: 'object', additionalProperties: false,
                          properties: {
                            kind: { type: 'string', required: true },
                            text: { type: 'string', required: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => json(value),
    },
    async execute(args, exec) {
      const { state } = targetOf(exec)
      const known = state.frames ?? []
      const requested = args.frame !== undefined ? [args.frame] : known.map(f => f.frameId)
      const targets = requested.length > 0 ? requested : [0]
      const frames: Array<Record<string, unknown>> = []
      for (const frameId of targets) {
        const scanned = await act(exec, {
          op: 'scan', frame: frameId,
          kinds: args.kinds, maxGapPx: args.maxGapPx, maxCandidates: args.maxCandidates,
          scope: args.scope, offset: args.offset, limit: args.limit,
        }, requestedTimeout(args)) as ScanResult
        const info = known.find(f => f.frameId === frameId)
        const controls = scanned.controls ?? []
        frames.push({
          frameId,
          frameUrl: scanned.frameUrl ?? info?.frameUrl ?? '',
          title: scanned.title ?? info?.title ?? '',
          total: scanned.total ?? controls.length,
          offset: scanned.offset ?? 0,
          count: scanned.count ?? controls.length,
          controls,
          ...scanned.scopeError === undefined ? {} : { scopeError: scanned.scopeError },
        })
      }
      return { frames }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'form_fill_batch',
    description: 'Write many values in one round trip: applies each {n, value} on the bound tab in page order and returns a '
      + 'per-item readback. Value semantics match form_fill ("true"/"false" for a checkbox/radio; option label or value for a '
      + 'native select). Items whose control already holds a valid value are skipped (no override); controls form_fill cannot '
      + 'write — custom widgets, disabled, hidden — are rejected with a reason, so fill those with form_click / form_type. '
      + 'No confirmation screenshots are taken; form_observe afterward to verify.',
    parameters: {
      items: {
        type: 'array', required: true,
        description: 'Writes to apply, in order.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            n: { type: 'integer', required: true, description: 'Element address from the snapshot.' },
            value: { type: 'string', required: true, description: 'Value to write; "true"/"false" for checkbox/radio.' },
            frame: { type: 'integer', description: 'Frame id. Defaults to 0.' },
          },
        },
      },
      ...TIMEOUT_PARAM,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          results: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: true,
              properties: {
                frame: { type: 'integer', required: true },
                n: { type: 'integer', required: true },
                ok: { type: 'boolean', required: true },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => json(value),
    },
    async execute(args, exec) {
      const groups = new Map<number, Array<{ n: number; value: string }>>()
      for (const item of args.items as Array<{ n: number; value: string; frame?: number }>) {
        const frame = item.frame ?? 0
        const group = groups.get(frame)
        if (group === undefined) groups.set(frame, [{ n: item.n, value: item.value }])
        else group.push({ n: item.n, value: item.value })
      }
      const results: Array<Record<string, unknown>> = []
      for (const [frame, items] of groups) {
        const back = await act(exec, { op: 'fill_many', frame, items }, requestedTimeout(args)) as {
          results?: Array<Record<string, unknown>>
        }
        for (const item of back.results ?? []) results.push({ frame, ...item })
      }
      return { results }
    },
  }))
}
