/**
 * Profile-injection edge cases: a missing directory, an unreadable entry, a
 * directory with no Markdown at all, and an over-limit profile. Each drives the
 * lazy `text` provider the plugin hands to the prompt assembler.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerPrompt } from '../src/prompt.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Capture the sections the plugin registers and return the profile provider.
 * The attachment directory defaults to a sibling that does not exist, so the
 * profile-only cases stay focused.
 */
function profileProvider(knowledgeDir: string, attachmentsDir = join(knowledgeDir, 'attachments')): () => string {
  const sections: Array<{ name: string; text: string | (() => string) }> = []
  const ctx = {
    systemPrompt: {
      section: (section: { name: string; text: string | (() => string) }) => { sections.push(section) },
    },
  } as unknown as Context
  registerPrompt(ctx, { knowledgeDir, attachmentsDir })
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

  it('names both directories and lists attachment files by absolute path', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.md'), '姓名：张三\n')
    const attachments = join(dir, 'files')
    await mkdir(attachments)
    await writeFile(join(attachments, '证书.pdf'), 'x')
    await writeFile(join(attachments, '证件照.jpg'), 'x')
    // A subdirectory is not an uploadable file and must not be listed.
    await mkdir(join(attachments, 'nested'))
    const text = profileProvider(dir, attachments)()
    expect(text).toContain(`资料目录（可写）：${resolve(dir)}`)
    expect(text).toContain(`附件目录（只读）：${resolve(attachments)}`)
    expect(text).toContain('# 可用附件（上传时用这些绝对路径）')
    expect(text).toContain(`- ${join(resolve(attachments), '证书.pdf')}`)
    expect(text).toContain(`- ${join(resolve(attachments), '证件照.jpg')}`)
    expect(text).not.toContain('nested')
  })

  it('resolves a relative profile dir against the session working directory', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'knowledge'))
    await writeFile(join(dir, 'knowledge', 'a.md'), '姓名：张三\n')
    const sections: Array<{ name: string; text: unknown }> = []
    const ctx = {
      systemPrompt: { section: (section: { name: string; text: unknown }) => { sections.push(section) } },
    } as unknown as Context
    registerPrompt(ctx, { knowledgeDir: 'knowledge', attachmentsDir: 'attachments' })
    const text = sections.find(section => section.name === 'form-filler:profile')!.text as (context: unknown) => string
    // The session cwd anchors the relative dir, not process.cwd().
    expect(text({ agent: { session: { header: { cwd: dir } } } })).toContain('姓名：张三')
    // Without a session the relative dir is not found, so nothing is injected.
    expect(text({})).not.toContain('姓名：张三')
  })

  it('truncates a profile beyond the character limit with a visible warning', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'huge.md'), 'x'.repeat(100_100))
    const text = profileProvider(dir)()
    expect(text.startsWith('【资料超过 100000 字符，已截断')).toBe(true)
    expect(text).toContain('x'.repeat(1000))
  })
})

describe('operating rules', () => {
  it('reads the rules file and documents the fast scan / batch-fill path', () => {
    const sections: Array<{ name: string; text: string | (() => string) }> = []
    const ctx = {
      systemPrompt: { section: (section: { name: string; text: string | (() => string) }) => { sections.push(section) } },
    } as unknown as Context
    registerPrompt(ctx, { knowledgeDir: 'missing', attachmentsDir: 'missing' })
    const section = sections.find(s => s.name === 'form-filler:rules')!
    const rules = typeof section.text === 'function' ? section.text() : section.text
    expect(rules).toContain('form_scan')
    expect(rules).toContain('form_fill_batch')
  })
})
