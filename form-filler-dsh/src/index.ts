/**
 * Form-filling plugin: a set of model-facing `form_*` tools that drive the
 * Profile Autocomplete browser extension over a loopback WebSocket bridge, plus
 * the operating rules and the user's own profile injected as prompt context.
 *
 * The plugin carries no orchestration of its own — the harness agent loop
 * decides what to observe and fill. It owns only the bridge, the tools, the
 * image working set, and the prompt sections. The browser extension keeps its existing wire protocol, so
 * its transport code needs no changes to talk to this plugin instead of the
 * retired Python backend.
 * @module @deepseek-ai/dsh-experimental-form-filler
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Bridge } from './bridge.ts'
import { ContextMemory } from './context-memory.ts'
import { ImageMemory } from './image-memory.ts'
import { registerPrompt } from './prompt.ts'
import { registerTools } from './tools.ts'

export const name = 'form-filler'
export const inject = ['tools', 'systemPrompt']

/** Bridge, storage, and profile locations for the form-filling plugin. */
export interface Config {
  /** Loopback listen host. @default '127.0.0.1' */
  host?: string
  /** Loopback listen port; zero requests an OS-assigned port. @default 8765 */
  port?: number
  /**
   * Directory receiving per-observation DOM snapshots, resolved against the
   * session working directory so the dumps stay with the workspace.
   * @default 'runs'
   */
  runDir?: string
  /**
   * Directory of the user's own `*.md` profile files, resolved against the
   * session working directory so each workspace carries its own profile.
   * @default 'knowledge'
   */
  knowledgeDir?: string
  /**
   * Directory of certificates, photos, and other files to upload, resolved
   * against the session working directory. @default 'attachments'
   */
  attachmentsDir?: string
  /**
   * How many component crops the injected image memory retains before the
   * oldest is evicted. @default 20
   */
  cropSlotSize?: number
}

/** Schemastery config for the form-filling plugin. */
export const Config: z<Config> = z.object({
  host: z.string(),
  port: z.number().min(0).step(1).default(8765),
  runDir: z.string(),
  knowledgeDir: z.string(),
  attachmentsDir: z.string(),
  cropSlotSize: z.number().min(1).step(1).default(20),
})

/** Concrete config after defaults are applied. */
export interface ResolvedConfig {
  host: string
  port: number
  runDir: string
  knowledgeDir: string
  attachmentsDir: string
  cropSlotSize: number
}

/**
 * Apply the documented defaults to a partial config. The snapshot, profile, and
 * attachment directories stay relative so they resolve under whatever session
 * working directory (the sandbox's writable root) the harness sets.
 * @param config - the partial plugin config.
 * @returns the config with every field resolved.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 8765,
    runDir: config.runDir ?? 'runs',
    knowledgeDir: config.knowledgeDir ?? 'knowledge',
    attachmentsDir: config.attachmentsDir ?? 'attachments',
    cropSlotSize: config.cropSlotSize ?? 20,
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const bridge = new Bridge({ host: resolved.host, port: resolved.port })
  ctx.effect(() => () => bridge.stop(), 'form-filler.bridge')
  await bridge.start()
  ctx.logger.info(`form-filler: bridge listening on ${resolved.host}:${bridge.port}`)

  const memory = new ImageMemory(name, { cropSlotSize: resolved.cropSlotSize })
  memory.install(ctx)

  const contextMemory = new ContextMemory(name)

  registerTools(ctx, { bridge, runDir: resolved.runDir, memory, contextMemory })
  registerPrompt(ctx, { knowledgeDir: resolved.knowledgeDir, attachmentsDir: resolved.attachmentsDir })
}
