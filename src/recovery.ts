/**
 * Mid-run recovery from terminal quota errors.
 *
 * Upstream retries a plain 429 (the router sees those as `retry` routes) but
 * deliberately not `insufficient_quota`, billing, or ChatGPT's
 * `subscription_sharing_usage_limit_exceeded`: those end the run. At
 * `agent_before_settle` this confirms the block with a fresh usage read, marks
 * the family exhausted, omits the failed assistant message with a
 * `context_edit`, and asks for one continuation. The continuation routes as
 * `continuation`, sees the previous model's family marked, and moves down the
 * chain.
 *
 * The failed message must be omitted: `convertToLlm` keeps error assistant
 * messages, and Pi refuses to continue a context that ends with an assistant.
 *
 * Each chain model is recovered at most once per user prompt, so a provider
 * whose usage endpoint keeps disagreeing with its errors cannot loop.
 */

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentBeforeSettleEvent, BoundaryResult, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import type { Profile } from "./config.js";
import { refKey, sameModel } from "./model-ref.js";
import { ChainExhaustedError, hasPartialOutput, isQuotaError, type RouteEnv, type Router } from "./router.js";

/** What happened at one settle boundary. */
export type RecoveryOutcome =
	| { kind: "none" }
	| { kind: "continue"; result: BoundaryResult; from: string; to: string }
	| { kind: "exhausted"; error: ChainExhaustedError };

/** The trailing failed assistant message and the entry that owns it. */
function trailingError(
	entries: readonly ProjectedSessionEntry[],
): { entryId: string; message: AssistantMessage } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const projected = entries[i];
		if (!projected || projected.messages.length === 0) continue;
		const last = projected.messages[projected.messages.length - 1];
		if (last?.role !== "assistant" || last.stopReason !== "error") return undefined;
		return { entryId: projected.sourceEntry.id, message: last };
	}
	return undefined;
}

/** Per-session recovery bookkeeping. */
export class SettleRecovery {
	private readonly recovered = new Set<string>();

	constructor(private readonly router: Router) {}

	/** Start a new user prompt: every chain model may be recovered once again. */
	resetTurn(): void {
		this.recovered.clear();
	}

	/**
	 * Decide whether the settling run ended on a confirmed quota error of a
	 * `profile` chain model, and if so how to continue.
	 */
	async handle(
		event: Pick<AgentBeforeSettleEvent, "entries" | "context">,
		profile: Profile,
		env: RouteEnv,
		signal: AbortSignal | undefined,
	): Promise<RecoveryOutcome> {
		const failed = trailingError(event.context.contextEntries);
		if (!failed || !isQuotaError(failed.message) || hasPartialOutput(failed.message)) return { kind: "none" };
		const { provider, model: id } = failed.message;
		const entry = profile.chain.find((item) => sameModel(item, { provider, id }));
		if (!entry) return { kind: "none" };
		const key = refKey({ provider, id });
		if (this.recovered.has(key)) return { kind: "none" };
		const model: Model<Api> | undefined = env.resolve(entry);
		if (!model || !(await this.router.confirm(model, env, signal, failed.message.timestamp))) return { kind: "none" };
		this.recovered.add(key);
		const next = this.router.pick(profile, env);
		if (!next.ok) return { kind: "exhausted", error: new ChainExhaustedError(profile.id, next.blocked, next.resetAt) };
		return {
			kind: "continue",
			from: key,
			to: refKey(next.entry),
			result: {
				entries: [...event.entries, { type: "context_edit", targetId: failed.entryId, replacement: null }],
				continue: true,
			},
		};
	}
}
