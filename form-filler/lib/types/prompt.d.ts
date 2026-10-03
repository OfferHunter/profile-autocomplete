/**
 * System-prompt contributions for the form-filling plugin: the operating
 * rules prose (how the model should drive the `form_*` tools) and the user's
 * own Markdown profile injected wholesale.
 *
 * Both are prompt sections rather than tool output: they are stable across a
 * task, so they sit in the cacheable prefix. The profile is read fresh on every
 * assembly, so edits on disk take effect without a restart.
 * @module @deepseek-ai/dsh-experimental-form-filler/prompt
 */
import type { Context } from '@deepseek-ai/cordis';
/** Options resolved once by the plugin. */
export interface PromptOptions {
    /** Directory holding the user's own `*.md` profile files. */
    knowledgeDir: string;
}
/**
 * Register the two system-prompt sections: the fixed operating rules and the
 * user's own profile, recomputed per request.
 * @param ctx - the plugin context carrying `ctx.systemPrompt`.
 * @param options - the resolved profile directory.
 */
export declare function registerPrompt(ctx: Context, options: PromptOptions): void;
//# sourceMappingURL=prompt.d.ts.map