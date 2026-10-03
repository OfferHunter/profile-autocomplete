/**
 * Real Loader composition: a `cordis.yml` boots SystemPrompt + ToolRuntime +
 * the form-filler plugin through the include plugin, with only the browser
 * extension faked (it is the external process). Assertions read the
 * model-visible tool schemas, the assembled prompt, and the snapshot files the
 * tool wrote to disk — not the plugin's internal state.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as FormFiller from '@deepseek-ai/dsh-experimental-form-filler'
import { connectExtension, freePort, type CommandMessage } from './harness.ts'

const TAB_MAIN = { id: 7, url: 'https://jobs.example.com/apply', title: '在线申请' }
const TAB_OTHER = { id: 9, url: 'https://jobs.example.com/other', title: '另一个页面' }
const TABS = [TAB_MAIN, TAB_OTHER]

const FRAME_MAIN = {
  frameId: 0, documentId: 'top-doc-1', frameUrl: TAB_MAIN.url, title: TAB_MAIN.title,
  html: '<html><body><input id="name"></body></html>', nodes: 12, error: null,
}
const FRAME_CHILD = {
  frameId: 2, documentId: 'child-doc', frameUrl: 'https://jobs.example.com/embedded', title: '内嵌',
  html: '<div id="inner">frame</div>', nodes: 3, error: 'frame unavailable',
}

const OBSERVE_RESULT = {
  url: TAB_MAIN.url,
  title: TAB_MAIN.title,
  document: 'top-doc-1',
  snapshot: 'snap-1',
  frames: [FRAME_MAIN, FRAME_CHILD],
  image: 'iVBORw0KGgo=',
  clip: { x: 0, y: 0, width: 800, height: 600 },
  pageHeight: 2400,
}

const SHOT_RESULT = {
  image: 'iVBORw0KGgo=',
  clip: { x: 0, y: 0, width: 640, height: 480 },
  pageHeight: 2400,
}

let root: string | undefined
let context: Context | undefined
let callCounter = 0

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function tool(name: string, args: unknown) {
  return context!.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: { session: { id: 'session-a' } } as never,
  })
}

function value(result: { value?: unknown }): Record<string, unknown> {
  return result.value as Record<string, unknown>
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Boot the plugin through the real Loader against the test's temp root. */
async function boot(config: Record<string, unknown>): Promise<void> {
  const configPath = join(root!, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-experimental-form-filler'",
    `  config: ${JSON.stringify(config)}`,
    '',
  ].join('\n'))

  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-experimental-form-filler', FormFiller],
  ])
  context = new Context()
  context.baseUrl = pathToFileURL(root!).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
}

describe('form-filler real Loader composition through cordis.yml', () => {
  it('registers the tool set, injects the prompt, and drives a faked extension', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-form-filler-'))
    const runDir = join(root, 'runs')
    const knowledgeDir = join(root, 'knowledge')
    await mkdir(knowledgeDir, { recursive: true })
    await writeFile(join(knowledgeDir, 'basic.md'), '# 基本信息\n\n姓名：张三\n')
    await writeFile(join(knowledgeDir, 'ignore.txt'), 'not a profile file\n')
    const port = await freePort()
    await boot({ port, runDir, knowledgeDir })

    let actReply: { ok: boolean; result?: unknown; error?: string } = {
      ok: true,
      result: { ok: true, dispatched: true, actual: '张三', box: { x: 1, y: 2, width: 3, height: 4, top: true } },
    }
    const extension = await connectExtension({
      port, browser: 'browser-a', tabs: TABS,
      respond: (command: CommandMessage) => {
        if (command.op === 'observe') return { ok: true, result: OBSERVE_RESULT }
        if (command.op === 'shot') return { ok: true, result: SHOT_RESULT }
        if (command.op === 'act') return actReply as { ok: true; result: unknown }
        return { ok: false, error: `unexpected op ${command.op}` }
      },
    })

    // --- tool schemas are model-visible -----------------------------------
    expect(context!.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'form_attach', 'form_click', 'form_fill', 'form_hover', 'form_look', 'form_observe',
      'form_read', 'form_scroll', 'form_tabs', 'form_type', 'form_upload', 'form_wait',
    ])

    // --- prompt sections carry the rules and the profile ------------------
    const assembly = await context!.systemPrompt.assemble()
    const rules = assembly.sections.find(section => section.name === 'form-filler:rules')
    expect(rules?.text).toContain('只填空白项')
    expect(rules?.text).toContain('form_observe')
    const profile = assembly.sections.find(section => section.name === 'form-filler:profile')
    expect(profile?.text).toContain('姓名：张三')
    expect(profile?.text).toContain('# 文件：basic.md')
    expect(profile?.text).not.toContain('not a profile file')

    // --- perception requires a binding -----------------------------------
    const unbound = await tool('form_observe', {})
    expect(unbound.isError).toBe(true)
    expect(text(unbound)).toContain('尚未绑定目标标签页')

    const tabs = await tool('form_tabs', {})
    expect(tabs.isError).toBe(false)
    expect(tabs.value).toEqual({ browsers: [{ browser: 'browser-a', bound: false, tabs: TABS }] })

    const missing = await tool('form_attach', { tabId: 99 })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('找不到标签页 99')

    const attached = await tool('form_attach', { tabId: 7 })
    expect(attached.value).toEqual({ browser: 'browser-a', tabId: 7, url: TAB_MAIN.url, title: TAB_MAIN.title })

    // The binding reset the snapshot: acting now must demand an observation.
    const noSnapshot = await tool('form_fill', { n: 3, value: '张三' })
    expect(noSnapshot.isError).toBe(true)
    expect(text(noSnapshot)).toContain('先调用 form_observe')

    // --- observe writes every frame to disk -------------------------------
    const observed = await tool('form_observe', { y: 100 })
    expect(observed.isError).toBe(false)
    const observedValue = value(observed)
    expect(observedValue.snapshotId).toBe('snap-1')
    expect(observedValue.documentId).toBe('top-doc-1')
    expect(observedValue.pageHeight).toBe(2400)
    expect(observedValue.image).toBeUndefined()
    const frames = observedValue.frames as Array<Record<string, unknown>>
    expect(frames.map(frame => frame.frameId)).toEqual([0, 2])
    const firstFrame = frames[0] as Record<string, unknown>
    const secondFrame = frames[1] as Record<string, unknown>
    expect(firstFrame.path).toBe(join(runDir, 'session-a', 'snap-1', 'frame-0.html'))
    expect(existsSync(firstFrame.path as string)).toBe(true)
    expect(await readFile(firstFrame.path as string, 'utf8')).toBe(FRAME_MAIN.html)
    expect(secondFrame.error).toBe('frame unavailable')
    expect(firstFrame.error).toBeUndefined()

    // --- a successful fill reads back and asks for a confirmation crop -----
    const fill = await tool('form_fill', { n: 3, value: '张三' })
    expect(fill.isError).toBe(false)
    expect(value(fill)).toMatchObject({ ok: true, dispatched: true, actual: '张三' })
    expect(value(fill).attempts).toBeUndefined()
    expect(extension.commands.map(command => command.op)).toEqual(['observe', 'act', 'shot'])

    // --- a refused fill counts attempts instead of failing the turn -------
    actReply = { ok: true, result: { ok: false, reason: 'already_filled', actual: '李四' } }
    expect(value(await tool('form_fill', { n: 4, value: '张三' })))
      .toMatchObject({ ok: false, reason: 'already_filled', attempts: 1 })
    expect(value(await tool('form_fill', { n: 4, value: '张三' })))
      .toMatchObject({ ok: false, reason: 'already_filled', attempts: 2 })

    // --- direct screenshot, no snapshot -----------------------------------
    expect((await tool('form_look', { n: 3 })).value)
      .toEqual({ clip: SHOT_RESULT.clip, pageHeight: 2400 })

    // --- readback ----------------------------------------------------------
    actReply = { ok: true, result: { ok: true, actual: { value: '张三' } } }
    expect((await tool('form_read', { n: 3 })).value)
      .toEqual({ ok: true, actual: { value: '张三' } })

    // --- typing ------------------------------------------------------------
    const noInput = await tool('form_type', {})
    expect(noInput.isError).toBe(true)
    expect(text(noInput)).toContain('需要 text 或 key')
    expect((await tool('form_type', { text: '张' })).value)
      .toMatchObject({ ok: true, actual: { value: '张三' } })

    // --- hover / scroll ----------------------------------------------------
    expect((await tool('form_hover', { n: 3 })).value).toMatchObject({ ok: true })
    const noTarget = await tool('form_scroll', {})
    expect(noTarget.isError).toBe(true)
    expect(text(noTarget)).toContain('需要 n 或 y')
    expect((await tool('form_scroll', { y: 800 })).value).toMatchObject({ ok: true })

    // --- wait --------------------------------------------------------------
    expect((await tool('form_wait', { ms: -5 })).value).toEqual({ waitedMs: 0 })

    // --- upload ------------------------------------------------------------
    expect((await tool('form_upload', { n: 5, path: 'C:/tmp/resume.pdf' })).value).toMatchObject({ ok: true })

    await extension.close()
  })

  it('defaults runDir and knowledgeDir below DSH_HOME when config omits them', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-form-filler-home-'))
    const port = await freePort()
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      await boot({ port })
      // A missing knowledge directory must yield an empty contribution, not a crash.
      const assembly = await context!.systemPrompt.assemble()
      expect(assembly.sections.find(section => section.name === 'form-filler:profile')?.text ?? '').toBe('')
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })
})
