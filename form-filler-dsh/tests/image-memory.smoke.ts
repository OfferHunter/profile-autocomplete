/**
 * Smoke test for ImageMemory's bounded-set logic and panel injection intent.
 * The vitest suite covers the tools end to end; this one drives the module
 * directly with a stub session for a fast, focused check. Run with tsx:
 *   ../../deepseek-harness/node_modules/.bin/tsx tests/image-memory.smoke.ts
 * from deepseek-harness, or the equivalent path to the tsx binary.
 */

import { ImageMemory } from '../src/image-memory.ts'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok  ${label}`)
  } else {
    failures += 1
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

interface Captured {
  type: string
  data: unknown
  opts: { surfaceOp?: unknown; sourceEventSeqs?: unknown } | undefined
}

function makeSession(): { session: any; captured: Captured[]; nodes: number[] } {
  const captured: Captured[] = []
  const nodes: number[] = []
  const events = new Map<number, any>()
  const session: any = {
    id: 's1',
    surface: { get nodes() { return nodes } },
    eventAt: (seq: number) => events.get(seq),
    append: (type: string, data: unknown, opts?: Captured['opts']) => {
      const seq = events.size
      const event = { type, seq, data, surfaceOp: opts?.surfaceOp }
      events.set(seq, event)
      captured.push({ type, data, opts })
      nodes.push(seq)
      return event
    },
  }
  return { session, captured, nodes }
}

const ref = (n: number) => ({
  attachmentId: `att-${n}`,
  mediaType: 'image/png' as const,
  bytes: 10,
  width: 10,
  height: 10,
})

function imageBlockCount(content: readonly any[]): number {
  return content.filter(block => block.type === 'image').length
}

async function main(): Promise<void> {
  let listener: any
  const ctx: any = { on: (_name: string, fn: any) => { listener = fn } }
  const memory = new ImageMemory('form-filler', { cropSlotSize: 3 })
  memory.install(ctx)
  check('pre-step listener registered', typeof listener === 'function')

  const { session, captured } = makeSession()
  const run = async () => listener({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))

  // 1. First update creates the panel with a plain append.
  const firstId = memory.recordFull(session, 1, 0, ref(1) as any, '整页观测')
  await run()
  check('first injection appends', captured.at(-1)?.opts?.surfaceOp === 'append', captured.at(-1)?.opts)
  const firstContent = (captured.at(-1)?.data as any).content
  check('panel carries header + caption + image', firstContent.length === 3, firstContent.length)
  check('header marks the panel as system-injected', String(firstContent[0].text).includes('非用户消息'))
  check('caption carries the id recordFull returned', String(firstContent[1].text) === `【id=${firstId}】tab=1 frame=0 整页观测`, firstContent[1].text)
  check('one image block', imageBlockCount(firstContent) === 1, imageBlockCount(firstContent))

  // 2. No change → no new injection.
  await run()
  check('unchanged set injects nothing', captured.length === 1, captured.length)

  // 3. Crop ring evicts to the configured size.
  for (let i = 2; i <= 6; i += 1) memory.recordCrop(session, ref(i) as any, `crop ${i}`)
  check('crop ring bounded to cropSlotSize', memory.summary(session).crops === 3, memory.summary(session))
  await run()
  const replaceOpts = captured.at(-1)?.opts
  check('later injection replaces in place', typeof replaceOpts?.surfaceOp === 'object' && (replaceOpts?.surfaceOp as any).op === 'replace', replaceOpts)
  const secondContent = (captured.at(-1)?.data as any).content
  check('full slot + 3 crops = 4 images', imageBlockCount(secondContent) === 4, imageBlockCount(secondContent))
  check('replace cites the shadowed node', Array.isArray(replaceOpts?.sourceEventSeqs) && (replaceOpts?.sourceEventSeqs as number[]).length === 1, replaceOpts?.sourceEventSeqs)

  // 4. drop_images removes by id and marks dirty.
  const cropIds = memory.summary(session)
  const dropped = memory.drop(session, [4, 5]) // ids assigned in record order
  check('drop reports a count', dropped >= 1, dropped)
  await run()
  const thirdContent = (captured.at(-1)?.data as any).content
  check('dropped images leave the panel', imageBlockCount(thirdContent) < imageBlockCount(secondContent), {
    cropIds, before: imageBlockCount(secondContent), after: imageBlockCount(thirdContent),
  })

  // 5. Dropping everything yields the empty panel, still a valid user message.
  memory.drop(session, [1, 2, 3, 6, 7, 8, 9, 10, 11, 12])
  await run()
  const lastContent = (captured.at(-1)?.data as any).content
  check('empty panel is a single text block', lastContent.length === 1 && lastContent[0].type === 'text', lastContent)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
