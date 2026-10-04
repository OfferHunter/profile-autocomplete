/**
 * ContextMemory fold logic: which surface nodes a checkpoint shadows, what the
 * surviving panel carries, and the structural guarantees (user/system nodes are
 * never folded, the panel becomes the next fold's boundary, empty runs are a
 * no-op). A stub session applies the surfaceOp so successive folds see the
 * rewritten surface, mirroring the real Session fold.
 */

import { describe, expect, it } from 'vitest'
import { ContextMemory } from '../src/context-memory.ts'

interface StubEvent {
  type: string
  seq: number
  data: unknown
  surfaceOp?: unknown
  sourceEventSeqs?: number[]
}

/** Minimal Session stand-in that applies append/replace to its node list. */
class StubSession {
  readonly log: StubEvent[] = []
  nodes: number[] = []

  get surface(): { nodes: number[] } {
    return { nodes: this.nodes }
  }

  eventAt(seq: number): StubEvent | undefined {
    return this.log[seq]
  }

  append(type: string, data: unknown, opts?: { surfaceOp?: unknown; sourceEventSeqs?: number[] }): StubEvent {
    const seq = this.log.length
    const event: StubEvent = {
      type, seq, data,
      ...opts?.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp },
      ...opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs },
    }
    this.log.push(event)
    const op = opts?.surfaceOp
    if (op === undefined || op === 'append') {
      this.nodes.push(seq)
    } else {
      const range = op as { startSeq: number; endSeq: number }
      const start = this.nodes.indexOf(range.startSeq)
      const end = this.nodes.indexOf(range.endSeq)
      this.nodes.splice(start, end - start + 1, seq)
    }
    return event
  }

  /** Append a plain surface node (the shape the harness writes). */
  push(type: string, data: unknown = {}): number {
    return this.append(type, data, { surfaceOp: 'append' }).seq
  }
}

const FOLDED_TYPES = new Set(['assistant/message', 'tool/result'])

function content(panel: StubEvent): Array<{ type: string; text: string }> {
  return (panel.data as { content: Array<{ type: string; text: string }> }).content
}

/** Seed a session with the standard opening: system prompt + the user's task. */
function seed(includeTask = true): StubSession {
  const session = new StubSession()
  session.push('system/message', { message: { content: [{ type: 'text', text: 'rules' }] } })
  if (includeTask) session.push('user/message', { content: [{ type: 'text', text: 'fill the form' }] })
  return session
}

describe('ContextMemory', () => {
  it('folds the run between the last hole and the current assistant message', () => {
    const session = seed()
    const a1 = session.push('assistant/message')
    const r1 = session.push('tool/result')
    const a2 = session.push('assistant/message') // current: carries the checkpoint call
    const memory = new ContextMemory('form-filler')

    const result = memory.fold(session as never, '填了基本信息', '快照：/runs/x/frame-0.html')

    expect(result.folded).toBe(2)
    // The two tool-chain nodes are shadowed; the panel takes their place.
    expect(session.nodes).toEqual([0, 1, result.panelSeq, a2])
    expect(session.nodes).not.toContain(a1)
    expect(session.nodes).not.toContain(r1)
  })

  it('cites every shadowed node and replaces exactly that range', () => {
    const session = seed()
    const a1 = session.push('assistant/message')
    const r1 = session.push('tool/result')
    session.push('assistant/message')
    const memory = new ContextMemory('form-filler')

    const { panelSeq } = memory.fold(session as never, '小结', '')
    const panel = session.log[panelSeq as number]

    expect(panel.type).toBe('user/message')
    expect(panel.surfaceOp).toEqual({ op: 'replace', startSeq: a1, endSeq: r1 })
    expect(panel.sourceEventSeqs).toEqual([a1, r1])
  })

  it('carries the header, the model summary, and the working set', () => {
    const session = seed()
    session.push('assistant/message')
    session.push('tool/result')
    session.push('assistant/message')
    const memory = new ContextMemory('form-filler')

    const { panelSeq } = memory.fold(session as never, '教育背景已填并保存', '待办：\n- [x] 基本信息')
    const blocks = content(session.log[panelSeq as number])

    expect(blocks).toHaveLength(3)
    expect(blocks[0]?.text).toContain('非用户发言')
    expect(blocks[1]).toEqual({ type: 'text', text: '【本段小结】教育背景已填并保存' })
    expect(blocks[2]?.text).toContain('待办：')
    expect(blocks[2]?.text).toContain('- [x] 基本信息')
  })

  it('omits the working-set block when there is nothing to show', () => {
    const session = seed()
    session.push('assistant/message')
    session.push('tool/result')
    session.push('assistant/message')
    const memory = new ContextMemory('form-filler')

    const { panelSeq } = memory.fold(session as never, '小结', '')
    expect(content(session.log[panelSeq as number])).toHaveLength(2)
  })

  it('never folds user or system nodes: an injected panel splits the run', () => {
    const session = seed()
    session.push('assistant/message') // first run (a1)
    session.push('tool/result')       // r1
    const panel = session.push('user/message') // e.g. the image memory panel — a hole
    const a2 = session.push('assistant/message') // second run (a2)
    const r2 = session.push('tool/result')       // r2
    session.push('assistant/message') // current
    const memory = new ContextMemory('form-filler')

    const result = memory.fold(session as never, '第二段', '')

    // Only the run after the injected panel is folded; the panel and the
    // earlier tool chain survive untouched.
    expect(result.folded).toBe(2)
    expect(session.log[result.panelSeq as number].sourceEventSeqs).toEqual([a2, r2])
    expect(session.nodes).toContain(panel)
    expect(session.nodes).toContain(0)
    expect(session.nodes).toContain(1)
  })

  it('is idempotent: the panel becomes the next fold boundary', () => {
    const session = seed()
    session.push('assistant/message')
    session.push('tool/result')
    const a2 = session.push('assistant/message')
    const memory = new ContextMemory('form-filler')

    expect(memory.fold(session as never, '第一段', '').folded).toBe(2)
    // Nothing new between the new panel and the still-last assistant message.
    expect(memory.fold(session as never, '重复', '').folded).toBe(0)
    expect(session.nodes).toContain(a2)
    expect(session.nodes.filter(seq => session.log[seq]?.type === 'tool/result')).toHaveLength(0)
  })

  it('folds nothing when there is no current assistant message', () => {
    const session = seed()
    const memory = new ContextMemory('form-filler')
    expect(memory.fold(session as never, '小结', '')).toEqual({ folded: 0, panelSeq: null })
    // An appended panel is the only node type ever added by a fold.
    expect(session.log.every(event => event.type !== 'user/message' || event === session.log[1])).toBe(true)
  })

  it('only ever shadows assistant/tool-result nodes', () => {
    const session = seed()
    session.push('assistant/message')
    session.push('tool/result')
    session.push('assistant/message')
    const memory = new ContextMemory('form-filler')

    const { panelSeq } = memory.fold(session as never, '小结', '')
    const panel = session.log[panelSeq as number]
    for (const seq of panel.sourceEventSeqs as number[]) {
      expect(FOLDED_TYPES.has(session.log[seq]?.type ?? '')).toBe(true)
    }
  })
})
