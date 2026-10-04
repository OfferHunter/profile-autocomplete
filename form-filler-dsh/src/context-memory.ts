/**
 * The text channel's counterpart of {@link ImageMemory}. Where the image set
 * keeps a bounded, always-current pile of screenshots out of the tool results,
 * this module keeps the verbose *tool-call chain* out of the history: when the
 * model finishes a section, its assistant reasoning and the tool calls/readbacks
 * that produced it are folded into a single checkpoint note carrying only the
 * model's own summary plus the current working set.
 *
 * The fold is deliberately narrow and structural, never judgemental:
 *
 * - It only ever shadows `assistant/message` and `tool/result` nodes. Every
 *   `user/message` (the user's own turns, the injected image panel, earlier
 *   checkpoints themselves) and every `system/message` (the system prompt and
 *   the plugin's own injected rules/profile) is left untouched — those act as
 *   holes the fold cannot cross.
 * - The folded range is exactly the contiguous run of tool-chain nodes between
 *   the *last* such hole and the current assistant message. There is no cursor
 *   to maintain: the checkpoint panel this module appends is itself a
 *   `user/message`, so it becomes the next fold's starting hole automatically.
 *
 * @module @deepseek-ai/dsh-experimental-form-filler/context-memory
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Panel header: states plainly that this is not user input and the chain is gone. */
const PANEL_HEADER = '【上下文概括 · 系统自动注入，非用户发言】'
  + '以下是你刚完成的一段工作的小结与工作集。这段里你更早的思考、工具调用与回读已被折叠，'
  + '只保留这里的内容；需要细节时按下面的快照文件路径重新 read，或用 form_observe 重新观测。'

/** Node types the fold is allowed to shadow. Everything else is a hole. */
const FOLDABLE = new Set(['assistant/message', 'tool/result'])

/** Result of one fold attempt. */
export interface CheckpointResult {
  /** How many surface nodes were folded away (0 when there was nothing to fold). */
  folded: number
  /** The surviving panel's seq, or null when nothing was folded. */
  panelSeq: SessionSeq | null
}

/**
 * Folds the current tool-chain run into one checkpoint panel. Holds one
 * instance for the whole plugin (stateless between calls — all state lives in
 * the session).
 */
export class ContextMemory {
  /**
   * @param plugin - the source name stamped on the panel so it is recognizable
   *   as plugin-owned on resume (and never mistaken for a real user turn).
   */
  constructor(private readonly plugin: string) {}

  /**
   * Replace the run of assistant/tool-result nodes between the last hole and
   * the current assistant message with a single plugin user panel holding
   * `kept` and `workSet`.
   * @param session - the session whose surface is rewritten.
   * @param kept - the model's own summary of the finished section; all that
   *   survives of it, so it must be self-sufficient.
   * @param workSet - pre-rendered working set (snapshot file paths, todo list).
   * @returns the number of nodes folded and the panel's seq, or `{0, null}` when
   *   there was nothing between the last hole and the current assistant message.
   */
  fold(session: Session, kept: string, workSet: string): CheckpointResult {
    const nodes = [...session.surface.nodes]
    const current = lastIndexOfType(session, nodes, 'assistant/message')
    if (current === -1) return { folded: 0, panelSeq: null }

    const hole = lastHoleBefore(session, nodes, current)
    const start = hole + 1
    const end = current - 1
    if (end < start) return { folded: 0, panelSeq: null }

    const shadowed = nodes.slice(start, end + 1)
    // Structural guard: by construction everything after the last hole is a
    // tool-chain node, but never fold anything else if that assumption breaks.
    if (!shadowed.every(seq => FOLDABLE.has(typeOf(session, seq) ?? ''))) {
      return { folded: 0, panelSeq: null }
    }

    const first = shadowed[0]
    const last = shadowed[shadowed.length - 1]
    /* v8 ignore next -- slice of a non-empty half-open range yields two entries */
    if (first === undefined || last === undefined) return { folded: 0, panelSeq: null }

    const event = session.append('user/message', buildPanel(this.plugin, kept, workSet), {
      surfaceOp: { op: 'replace', startSeq: first, endSeq: last },
      sourceEventSeqs: shadowed,
    })
    return { folded: shadowed.length, panelSeq: event.seq }
  }
}

/** The event type of one surface node, or undefined for a seq outside the log. */
function typeOf(session: Session, seq: SessionSeq): string | undefined {
  // oxlint-disable-next-line typescript/no-deprecated -- surface classification at a checkpoint
  return session.eventAt(seq)?.type
}

/** Index of the last node of the given type, scanning backwards, or -1. */
function lastIndexOfType(session: Session, nodes: readonly SessionSeq[], type: string): number {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const seq = nodes[i]
    if (seq !== undefined && typeOf(session, seq) === type) return i
  }
  return -1
}

/** Index of the last `user/message`/`system/message` node before `before`, or -1. */
function lastHoleBefore(session: Session, nodes: readonly SessionSeq[], before: number): number {
  for (let i = before - 1; i >= 0; i -= 1) {
    const seq = nodes[i]
    if (seq === undefined) continue
    const type = typeOf(session, seq)
    if (type === 'user/message' || type === 'system/message') return i
  }
  return -1
}

/** Build the checkpoint panel: header, the model's summary, and the working set. */
function buildPanel(plugin: string, kept: string, workSet: string): UserMessage {
  const content: ContentBlock[] = [{ type: 'text', text: PANEL_HEADER }]
  content.push({ type: 'text', text: `【本段小结】${kept}` })
  if (workSet.length > 0) content.push({ type: 'text', text: `【工作集】\n${workSet}` })
  return createUserMessage({ content, source: { kind: 'plugin', plugin } })
}
