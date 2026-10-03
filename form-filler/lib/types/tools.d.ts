/**
 * The model-facing form-filling tool set: perception primitives (`form_tabs`,
 * `form_attach`, `form_observe`, `form_look`, `form_read`) plus action
 * primitives (`form_fill`, `form_click`, `form_type`, `form_hover`,
 * `form_scroll`, `form_wait`, `form_upload`).
 *
 * Every primitive is deliberately free of local judgement: nothing here decides
 * what counts as a field or whether a control "should" be filled. The snapshot
 * is written to disk verbatim and the model reads the region it cares about;
 * each action returns the browser's readback of the resulting real state.
 * @module @deepseek-ai/dsh-experimental-form-filler/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Bridge } from './bridge.ts';
/** Options resolved once by the plugin and shared by every tool. */
export interface ToolsOptions {
    bridge: Bridge;
    runDir: string;
}
/**
 * Register the twelve `form_*` tools on the plugin context.
 * @param ctx - the plugin context carrying `ctx.tools`.
 * @param options - the bridge, the snapshot run directory, and the optional image store.
 */
export declare function registerTools(ctx: Context, options: ToolsOptions): void;
//# sourceMappingURL=tools.d.ts.map