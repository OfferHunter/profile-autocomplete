/**
 * System-prompt contributions for the form-filling plugin: the operating
 * rules prose (how the model should drive the `form_*` tools) and the user's
 * own Markdown profile injected wholesale.
 *
 * Both are prompt sections rather than tool output: they are stable across a
 * task, so they sit in the cacheable prefix. Both are read fresh on every
 * assembly, so edits on disk take effect without a restart — the rules live in
 * `prompts/system.md` at the package root, editable without touching this file.
 * @module @deepseek-ai/dsh-experimental-form-filler/prompt
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Section order for the profile. It sits just after the deployment persona so
 * personal facts precede instructions that reference them, and stay in the
 * stable prefix the provider can cache.
 */
const PROFILE_ORDER = 20

/** Section order for the rules prose, grouped after the built-in tool docs. */
const RULES_ORDER = 3020

/** Refuse to inject a profile beyond this many characters (matches the retired backend). */
const KNOWLEDGE_CHAR_LIMIT = 100_000

/**
 * The operating-rules prose, kept as a file so it can be edited without
 * touching code. Resolved against this module so it works wherever the plugin
 * is loaded from (the patch file runs it through tsx with no build step).
 */
const SYSTEM_PROMPT_FILE = fileURLToPath(new URL('../prompts/system.md', import.meta.url))

/** Options resolved once by the plugin. */
export interface PromptOptions {
  /** Directory holding the user's own `*.md` profile files. */
  knowledgeDir: string
  /** Directory holding certificates, photos, and other files to upload. */
  attachmentsDir: string
}

/**
 * Register the two system-prompt sections: the operating rules (read from
 * `prompts/system.md`) and the user's own profile, both recomputed per request.
 * @param ctx - the plugin context carrying `ctx.systemPrompt`.
 * @param options - the resolved profile and attachment directories.
 */
export function registerPrompt(ctx: Context, options: PromptOptions): void {
  ctx.systemPrompt.section({
    name: 'form-filler:rules',
    order: RULES_ORDER,
    text: () => readSystemPrompt(ctx),
    interpolate: false,
  })

  ctx.systemPrompt.section({
    name: 'form-filler:profile',
    order: PROFILE_ORDER,
    interpolate: false,
    // Anchor the relative profile/attachment dirs to the session's own working
    // directory on every assembly. Resolving against process.cwd() instead would
    // miss the workspace: the CLI runs with the package dir as cwd and never
    // chdirs, so the model would see an empty profile and read the files itself.
    text: context => readProfile(
      resolve(sessionCwd(context), options.knowledgeDir),
      resolve(sessionCwd(context), options.attachmentsDir),
    ),
  })
}

/**
 * The session working directory for one prompt assembly, used to anchor the
 * relative profile and attachment directories. Falls back to the process cwd
 * when no agent is attached (diagnostic assemblies).
 */
function sessionCwd(context: unknown): string {
  const agent = (context as { agent?: { session?: { header?: { cwd?: string } } } } | undefined)?.agent
  return agent?.session?.header?.cwd ?? process.cwd()
}

/**
 * Read the operating-rules file fresh on every assembly, so edits on disk take
 * effect without a restart. A missing or unreadable file is surfaced in the
 * prompt (and the log) rather than silently dropping the rules.
 */
function readSystemPrompt(ctx: Context): string {
  try {
    return readFileSync(SYSTEM_PROMPT_FILE, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.error(`form-filler: 无法读取系统提示词 ${SYSTEM_PROMPT_FILE}：${message}`)
    return `【form-filler 系统提示词读取失败：${SYSTEM_PROMPT_FILE}（${message}）；请检查插件安装是否完整。】`
  }
}

/**
 * Read every `*.md` below the profile directory into one document, naming the
 * writable profile directory and the read-only attachment directory up front
 * and listing the latter's files so the model can upload by absolute path. A
 * missing profile directory yields an empty contribution; an over-limit
 * profile is truncated with a visible warning rather than silently dropped.
 */
function readProfile(knowledgeDir: string, attachmentsDir: string): string {
  let files: string[]
  try {
    files = readdirSync(knowledgeDir).filter(name => name.toLowerCase().endsWith('.md')).sort()
  } catch {
    return ''
  }
  const parts: string[] = []
  for (const name of files) {
    let body: string
    try {
      body = readFileSync(join(knowledgeDir, name), 'utf8')
    } catch {
      continue
    }
    parts.push(`# 文件：${name}\n${body}`)
  }
  if (parts.length === 0) return ''
  const header = `# 个人资料\n\n资料目录（可写）：${resolve(knowledgeDir)}\n附件目录（只读）：${resolve(attachmentsDir)}\n\n以下为本人真实资料，填报时以此为准。`
  // The attachment index trails the profile so a truncated contribution drops
  // it first — the header still names the directory for a glob fallback.
  const text = `${header}\n\n${parts.join('\n\n')}${renderAttachments(attachmentsDir)}`
  if (text.length <= KNOWLEDGE_CHAR_LIMIT) return text
  const warning = `【资料超过 ${KNOWLEDGE_CHAR_LIMIT} 字符，已截断；请精简 ${knowledgeDir} 下的 .md 后再继续，未显示的部分视为缺失并以 ask_user_question 询问用户。】`
  return `${warning}\n\n${text.slice(0, KNOWLEDGE_CHAR_LIMIT)}`
}

/**
 * List the files directly under the attachment directory by absolute path, for
 * `form_upload`. A missing or empty directory contributes nothing.
 */
function renderAttachments(attachmentsDir: string): string {
  let names: string[]
  try {
    names = readdirSync(attachmentsDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort()
  } catch {
    return ''
  }
  if (names.length === 0) return ''
  const dir = resolve(attachmentsDir)
  const lines = names.map(name => `- ${join(dir, name)}`)
  return `\n\n# 可用附件（上传时用这些绝对路径）\n${lines.join('\n')}`
}
