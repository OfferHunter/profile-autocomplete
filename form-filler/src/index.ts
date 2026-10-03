/**
 * Form-filling plugin: a set of model-facing `form_*` tools that drive the
 * Profile Autocomplete browser extension over a loopback WebSocket bridge, plus
 * the operating rules and the user's own profile injected as prompt context.
 *
 * The plugin carries no orchestration of its own — the harness agent loop
 * decides what to observe and fill. It owns only the bridge, the tools, and the
 * prompt sections. The browser extension keeps its existing wire protocol, so
 * its transport code needs no changes to talk to this plugin instead of the
 * retired Python backend.
 * @module @deepseek-ai/dsh-experimental-form-filler
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { Bridge } from './bridge.ts'
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
  /** Directory receiving per-observation DOM snapshots. Defaults below `$DSH_HOME`. */
  runDir?: string
  /** Directory of the user's own `*.md` profile files. Defaults below `$DSH_HOME`. */
  knowledgeDir?: string
}

/** Schemastery config for the form-filling plugin. */
export const Config: z<Config> = z.object({
  host: z.string(),
  port: z.number().min(0).step(1).default(8765),
  runDir: z.string(),
  knowledgeDir: z.string(),
})

/** Concrete config after defaults are applied. */
export interface ResolvedConfig {
  host: string
  port: number
  runDir: string
  knowledgeDir: string
}

/**
 * Apply the documented defaults to a partial config.
 * @param config - the partial plugin config.
 * @returns the config with every field resolved.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 8765,
    runDir: config.runDir ?? dshHomePath('form-filler', 'runs'),
    knowledgeDir: config.knowledgeDir ?? dshHomePath('form-filler', 'knowledge'),
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const bridge = new Bridge({ host: resolved.host, port: resolved.port })
  ctx.effect(() => () => bridge.stop(), 'form-filler.bridge')
  await bridge.start()
  ctx.logger.info(`form-filler: bridge listening on ${resolved.host}:${bridge.port}`)

  registerTools(ctx, { bridge, runDir: resolved.runDir })
  registerPrompt(ctx, { knowledgeDir: resolved.knowledgeDir })
}
