/**
 * Profile-injection edge cases: a missing directory, an unreadable entry, a
 * directory with no Markdown at all, and an over-limit profile. Each drives the
 * lazy `text` provider the plugin hands to the prompt assembler.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerPrompt } from '../src/prompt.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Capture the sections the plugin registers and return the profile provider. */
function profileProvider(knowledgeDir: string): () => string {
  const sections: Array<{ name: string; text: string | (() => string) }> = []
  const ctx = {
    systemPrompt: {
      section: (section: { name: string; text: string | (() => string) }) => { sections.push(section) },
    },
  } as unknown as Context
  registerPrompt(ctx, { knowledgeDir })
  return sections.find(section => section.name === 'form-filler:profile')!.text as () => string
}

async function tempDir(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-form-filler-prompt-'))
  return root
}

describe('readProfile', () => {
  it('returns an empty contribution when the directory is missing', async () => {
    const dir = join(await tempDir(), 'does-not-exist')
    expect(profileProvider(dir)()).toBe('')
  })

  it('returns an empty contribution when no Markdown file exists', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'notes.txt'), 'ignored\n')
    expect(profileProvider(dir)()).toBe('')
  })

  it('skips an unreadable .md entry but keeps the readable ones', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.md'), '姓名：张三\n')
    // A directory named like a profile file makes readFileSync throw.
    await mkdir(join(dir, 'broken.md'))
    const text = profileProvider(dir)()
    expect(text).toContain('# 文件：a.md')
    expect(text).toContain('姓名：张三')
    expect(text).not.toContain('broken.md')
  })

  it('truncates a profile beyond the character limit with a visible warning', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'huge.md'), 'x'.repeat(100_100))
    const text = profileProvider(dir)()
    expect(text.startsWith('【资料超过 100000 字符，已截断')).toBe(true)
    expect(text).toContain('x'.repeat(1000))
  })
})
