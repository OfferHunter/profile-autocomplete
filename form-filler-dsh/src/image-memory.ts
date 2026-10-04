/**
 * The image channel's working memory. Every screenshot a `form_*` tool captures
 * — full-page observations and targeted component crops alike — is recorded
 * here instead of riding its own tool result, so the model-visible history
 * carries a bounded, always-current set rather than an ever-growing pile of
 * stale images.
 *
 * The set is one full-page shot per `(tab, frame)` plus a FIFO ring of the
 * most recent crops; the model can prune crops early with `drop_images`. Each
 * turn the module folds the set into a single plugin-owned user message — a
 * panel — and replaces that same node on the next update via a rolling
 * `surfaceOp: 'replace'`, so exactly one panel ever lives on the surface.
 *
 * Images are allowed only in user-role content, and the harness commits the
 * previous step's tool results before dispatching `agent/pre-step`, so the
 * panel append never lands between an assistant tool call and its results.
 * @module @deepseek-ai/dsh-experimental-form-filler/image-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Panel header injected beside the images; states plainly that this is not user input. */
const PANEL_HEADER = '【图像记忆 · 系统自动注入，非用户消息】'
  + '以下是你最近观测到的页面截图，每张带 id 与来源。字段名和选项以 DOM 快照文件为准，截图只用于视觉确认。'
  + '不再需要的局部图可用 drop_images({ids:[…]}) 释放上下文；不确定就别丢。'

/** Panel header when every image has been dropped. */
const PANEL_EMPTY = '【图像记忆 · 系统自动注入，非用户消息】当前没有保留任何截图。'

/** One image retained in the working set. */
interface Entry {
  /** Stable handle across turns, referenced by `drop_images`. */
  id: number
  ref: ImageAttachmentRef
  /** Model-facing caption: kind, source (tab/frame/element), and timestamp-free provenance. */
  caption: string
}

/** Per-session bounded image set and the surface node it currently occupies. */
interface SessionState {
  nextId: number
  /** One full-page shot per `tab:frame`. */
  full: Map<string, Entry>
  /** Component crops, oldest first. */
  crops: Entry[]
  /** The surface seq of the panel node, so the next update replaces it in place. */
  panelSeq: SessionSeq | undefined
  /** Whether the set changed since the last injected panel. */
  dirty: boolean
}

/** Bound on retained crops; full-page shots are separately capped at one per frame. */
export interface ImageMemoryOptions {
  /** How many component crops to retain before the oldest is evicted. */
  cropSlotSize: number
}

/**
 * Owns the image working set and injects it as one rolling panel message.
 */
export class ImageMemory {
  private readonly sessions = new Map<string, SessionState>()

  /**
   * @param plugin - the source name stamped on the panel so it can be recognized on resume.
   * @param options - the crop ring size.
   */
  constructor(
    private readonly plugin: string,
    private readonly options: ImageMemoryOptions,
  ) {}

  /**
   * Register the `agent/pre-step` listener that folds the set into the panel.
   * The prior step's tool results are already committed at this point, so the
   * append/replace never splits a tool call from its results.
   * @param ctx - the plugin context; the listener is disposed with it.
   */
  install(ctx: Context): void {
    ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const session = agent.session
      const state = this.stateOf(session)
      if (!state.dirty) return decision
      const message = this.buildPanel(state)
      state.dirty = false
      const prev = state.panelSeq
      const replaceable = prev !== undefined && session.surface.nodes.includes(prev)
      const event = replaceable
        ? session.append('user/message', message, {
          surfaceOp: { op: 'replace', startSeq: prev, endSeq: prev },
          sourceEventSeqs: [prev],
        })
        : session.append('user/message', message, { surfaceOp: 'append' })
      state.panelSeq = event.seq
      return decision
    })
  }

  /** Retain a full-page shot for one `(tab, frame)`, replacing any earlier one. @returns its id. */
  recordFull(session: Session, tab: number, frame: number, ref: ImageAttachmentRef, caption: string): number {
    const state = this.stateOf(session)
    const id = state.nextId++
    state.full.set(`${tab}:${frame}`, {
      id,
      ref,
      caption: `tab=${tab} frame=${frame} ${caption}`,
    })
    state.dirty = true
    return id
  }

  /** Append a component crop, evicting the oldest once the ring is full. @returns its id. */
  recordCrop(session: Session, ref: ImageAttachmentRef, caption: string): number {
    const state = this.stateOf(session)
    const id = state.nextId++
    state.crops.push({ id, ref, caption })
    while (state.crops.length > this.options.cropSlotSize) state.crops.shift()
    state.dirty = true
    return id
  }

  /**
   * Drop the images whose ids the model named, from either slot.
   * @returns how many images were removed.
   */
  drop(session: Session, ids: readonly number[]): number {
    const state = this.stateOf(session)
    const doomed = new Set(ids)
    let dropped = 0
    for (const [key, entry] of state.full) {
      if (doomed.has(entry.id)) {
        state.full.delete(key)
        dropped += 1
      }
    }
    state.crops = state.crops.filter(entry => {
      if (!doomed.has(entry.id)) return true
      dropped += 1
      return false
    })
    if (dropped > 0) state.dirty = true
    return dropped
  }

  /** Report the live set for a tool result, so the model can see what a drop left. */
  summary(session: Session): { full: number; crops: number } {
    const state = this.stateOf(session)
    return { full: state.full.size, crops: state.crops.length }
  }

  /** Resolve or lazily create one session's state, restoring its panel node on resume. */
  private stateOf(session: Session): SessionState {
    const key = String(session.id)
    let state = this.sessions.get(key)
    if (state === undefined) {
      state = { nextId: 1, full: new Map(), crops: [], panelSeq: this.findPanelSeq(session), dirty: false }
      this.sessions.set(key, state)
    }
    return state
  }

  /** Find a surviving panel node in the surface, so a resumed session replaces rather than appends. */
  private findPanelSeq(session: Session): SessionSeq | undefined {
    let found: SessionSeq | undefined
    for (const seq of session.surface.nodes) {
      const event = session.eventAt(seq)
      if (event?.type !== 'user/message') continue
      if (event.data.source.kind === 'plugin' && event.data.source.plugin === this.plugin) found = seq
    }
    return found
  }

  /** Build the panel message: a header, then each image with its caption beside it. */
  private buildPanel(state: SessionState): UserMessage {
    const entries = [...state.full.values(), ...state.crops]
    if (entries.length === 0) {
      return createUserMessage({
        content: [{ type: 'text', text: PANEL_EMPTY }],
        source: { kind: 'plugin', plugin: this.plugin },
      })
    }
    const content: ContentBlock[] = [{ type: 'text', text: PANEL_HEADER }]
    for (const entry of entries) {
      content.push({ type: 'text', text: `【id=${entry.id}】${entry.caption}` })
      content.push({ type: 'image', attachment: entry.ref })
    }
    return createUserMessage({ content, source: { kind: 'plugin', plugin: this.plugin } })
  }
}
