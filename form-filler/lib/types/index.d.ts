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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "form-filler";
export declare const inject: string[];
/** Bridge, storage, and profile locations for the form-filling plugin. */
export interface Config {
    /** Loopback listen host. @default '127.0.0.1' */
    host?: string;
    /** Loopback listen port; zero requests an OS-assigned port. @default 8765 */
    port?: number;
    /** Directory receiving per-observation DOM snapshots. Defaults below `$DSH_HOME`. */
    runDir?: string;
    /** Directory of the user's own `*.md` profile files. Defaults below `$DSH_HOME`. */
    knowledgeDir?: string;
}
/** Schemastery config for the form-filling plugin. */
export declare const Config: z<Config>;
/** Concrete config after defaults are applied. */
export interface ResolvedConfig {
    host: string;
    port: number;
    runDir: string;
    knowledgeDir: string;
}
/**
 * Apply the documented defaults to a partial config.
 * @param config - the partial plugin config.
 * @returns the config with every field resolved.
 */
export declare function resolveConfig(config: Config): ResolvedConfig;
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map