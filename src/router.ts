/**
 * Chain routing for the `router/<profile>` virtual models.
 *
 * Eligibility never touches the network: a chain entry is skipped when a
 * confirmed exhaustion mark covers it, or when cached usage already shows its
 * window exhausted. Stale or missing usage fails open. The only network read
 * is `confirm`, a fresh usage read after a quota-looking failure; nothing is
 * marked unless that read shows the block.
 */

import type { Api, AssistantMessage, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { type ChainEntry, type Exhaustion, type Profile, ROUTER_PROVIDER } from "./config.js";
import type { ExhaustionTracker } from "./exhaustion.js";
import { type ModelRef, parseRef, refKey, sameModel } from "./model-ref.js";
import { formatScore, type QuotaScore, scoreQuota, selectCandidate } from "./selection.js";
import type { UsageDecision, UsageSnapshot } from "./usage.js";

/**
 * Failure text worth a confirming usage read: rate limits and 429s (which
 * upstream retries) plus the terminal quota, billing and subscription-limit
 * errors upstream's `retry.ts` deliberately does not retry. Only a confirmed
 * read acts on it, so over-matching costs one cached request.
 */
const QUOTA_ERROR_PATTERN =
	/\b429\b|quota|rate.?limit|too many requests|usage.?limit|billing|out of budget|extra.?usage|available balance|UsageLimitError|subscription_sharing_usage_limit_exceeded/i;

/** Whether an assistant error could be subscription quota. */
export function isQuotaError(message: Pick<AssistantMessage, "stopReason" | "errorMessage">): boolean {
	return message.stopReason === "error" && QUOTA_ERROR_PATTERN.test(message.errorMessage ?? "");
}

/** A failed stream with output cannot be transparently replayed without duplicating visible output. */
export function hasPartialOutput(message: Pick<AssistantMessage, "content">): boolean {
	return message.content.some(
		(part) => part.type === "toolCall" || (part.type === "text" ? part.text.length > 0 : part.thinking.length > 0),
	);
}

/** What the router needs from the host. `ExtensionContext` provides it in production. */
export interface RouteEnv {
	/** The physical model for a chain entry, or undefined when unknown or without credentials. */
	resolve(entry: ChainEntry): Model<Api> | undefined;
	/**
	 * Decision for `model` from the exact fresh snapshot started at or after
	 * `notBefore`. Unavailable reads return undefined; must not reject.
	 */
	refresh(model: ModelRef, signal: AbortSignal | undefined, notBefore: number): Promise<UsageDecision | undefined>;
}

/** The slice of `UsageService` routing depends on. */
export interface UsageDecider {
	decisionFor(model: ModelRef): UsageDecision;
	/** Cached only. Unknown collectors remain usable fallback candidates. */
	peek?(provider: string): UsageSnapshot | undefined;
}

/** Why a chain entry is not eligible right now. */
export interface Ineligible {
	entry: ChainEntry;
	reason: string;
	resetAt?: number;
	/** Blocked by exhausted quota, as opposed to unknown or missing credentials. */
	quota: boolean;
}

/**
 * ISO time without milliseconds. Upstream's retry classifier matches a bare
 * `500`/`502`/`503` anywhere in an error, so `...:03.500Z` would turn a routing
 * failure into automatic retries.
 */
export function isoSeconds(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Eligible candidates, including the diagnostics used by selection. */
export interface Candidate {
	entry: ChainEntry;
	model: Model<Api>;
	score: QuotaScore;
	/** Age of the cached snapshot the score came from; absent when there was none. */
	ageMs?: number;
}

/** Why one routing pick happened: what each candidate scored on what data. JSON-safe. */
export interface RouteDecision {
	at: number;
	profile: string;
	strategy: "ordered" | "balanced";
	reason: ModelRouteRequest["reason"];
	/** `provider/id` of the chosen entry. */
	chosen: string;
	candidates: { model: string; quota: QuotaScore; ageMs?: number }[];
	/** Entries skipped as ineligible, with the reason. */
	blocked: { model: string; reason: string }[];
}

/** Outcome of `Router.pick`, shared by route, recovery, admission and status. */
export type PickResult =
	| { ok: true; entry: ChainEntry; model: Model<Api>; candidates: Candidate[]; blocked: Ineligible[] }
	| { ok: false; blocked: Ineligible[]; resetAt?: number };

/** Multi-line, human-readable form of a decision for `/router status`. */
export function formatDecision(decision: RouteDecision): string {
	const lines = [
		`${isoSeconds(decision.at)} router/${decision.profile} ${decision.reason} -> ${decision.chosen} (${decision.strategy})`,
	];
	for (const c of decision.candidates) {
		const age = c.ageMs === undefined ? "no data" : `data ${Math.floor(c.ageMs / 60_000)}m old`;
		lines.push(`    ${c.model}: ${formatScore(c.quota)}, ${age}`);
	}
	for (const b of decision.blocked) lines.push(`    ${b.model}: ${b.reason}`);
	return lines.join("\n");
}

/** Reply to a pi-subagents admission request (`router:rpc:admit`). */
export interface Admission {
	ok: boolean;
	/** The physical model the dispatch would start on. */
	resolvedModel?: string;
	/** Earliest known reset when refused. */
	resetAt?: number;
	/**
	 * When refused: true if the caller may park the dispatch until `resetAt`
	 * (the profile's `exhaustionPolicy` is "wait", a reset is known, and it is
	 * within `maxWaitMinutes`). False means fail now.
	 */
	wait?: boolean;
}

/** Thrown when every chain entry is blocked. Carries the earliest known reset. */
export class ChainExhaustedError extends Error {
	constructor(
		readonly profile: string,
		readonly blocked: Ineligible[],
		readonly resetAt: number | undefined,
	) {
		const when = resetAt === undefined ? "an unknown time" : isoSeconds(resetAt);
		const detail = blocked.map((item) => `${refKey(item.entry)}: ${item.reason}`).join("; ");
		super(`router/${profile}: every model is unavailable (${detail}). Earliest reset ${when}.`);
		this.name = "ChainExhaustedError";
	}
}

/** Whether a refused dispatch may park until `resetAt` under `exhaustion` (default: wait, no limit). */
export function canWait(exhaustion: Exhaustion | undefined, resetAt: number | undefined, now: number): boolean {
	if (resetAt === undefined || exhaustion?.policy === "fail") return false;
	return exhaustion?.maxWaitMs === undefined || resetAt - now <= exhaustion.maxWaitMs;
}

/** Stateless over requests; all quota state lives in the shared tracker and usage cache. */
export class Router {
	constructor(
		private readonly usage: UsageDecider,
		private readonly tracker: ExhaustionTracker,
		private readonly now: () => number = Date.now,
		/** Called once per scored pick (not sticky continuations or same-model retries). */
		private readonly onDecision?: (decision: RouteDecision) => void,
	) {}

	/** Why `model` is blocked, or undefined when it is eligible. */
	blockedBy(model: ModelRef): { reason: string; resetAt?: number } | undefined {
		const mark = this.tracker.blocking(model);
		if (mark) {
			const kind = mark.resetKnown ? "resets" : "backing off until";
			return { reason: `${mark.window} exhausted, ${kind} ${isoSeconds(mark.until)}`, resetAt: mark.until };
		}
		const decision = this.usage.decisionFor(model);
		if (decision.block) return { reason: `${decision.window ?? "quota"} exhausted`, resetAt: decision.resetAt };
		return undefined;
	}

	/**
	 * Admission for a dispatch on `ref` ("provider/id"). A physical model is
	 * refused only while blocked; one we know nothing about is not ours to veto.
	 * A `router/<profile>` is refused only when some entry is quota-blocked and
	 * none is eligible: a chain unusable for config or credential reasons is
	 * admitted, so the child fails with the real cause instead of a bogus
	 * "quota exhausted, unknown reset".
	 */
	admit(ref: string, profiles: ReadonlyMap<string, Profile>, env: RouteEnv): Admission {
		const parsed = parseRef(ref);
		if (!parsed) return { ok: true };
		const { provider, id } = parsed;
		if (provider === ROUTER_PROVIDER) {
			const profile = profiles.get(id);
			if (!profile) return { ok: true };
			const picked = this.pick(profile, env);
			if (picked.ok) return { ok: true, resolvedModel: refKey(picked.entry) };
			if (!picked.blocked.some((item) => item.quota)) return { ok: true };
			return { ok: false, resetAt: picked.resetAt, wait: canWait(profile.exhaustion, picked.resetAt, this.now()) };
		}
		const blocked = this.blockedBy({ provider, id });
		if (!blocked) return { ok: true, resolvedModel: ref };
		return { ok: false, resetAt: blocked.resetAt, wait: canWait(undefined, blocked.resetAt, this.now()) };
	}

	/** Cached-only selection; balanced user prompts may supply an eligible incumbent. */
	pick(profile: Profile, env: RouteEnv, incumbent?: ModelRef): PickResult {
		const blocked: Ineligible[] = [];
		const candidates: Candidate[] = [];
		const now = this.now();
		for (const entry of profile.chain) {
			const model = env.resolve(entry);
			if (!model) {
				blocked.push({ entry, reason: "not available (unknown model or no credentials)", quota: false });
				continue;
			}
			const block = this.blockedBy(model);
			if (!block) {
				const snapshot = this.usage.peek?.(model.provider);
				candidates.push({
					entry,
					model,
					score: scoreQuota(model, snapshot, now),
					...(snapshot ? { ageMs: Math.max(0, now - snapshot.retrievedAt) } : {}),
				});
			} else blocked.push({ entry, ...block, quota: true });
		}
		const index = selectCandidate(
			candidates.map((candidate) => candidate.score),
			profile.strategy,
			incumbent ? candidates.findIndex((candidate) => sameModel(candidate.entry, incumbent)) : undefined,
		);
		const selected = candidates[index];
		if (selected) return { ok: true, entry: selected.entry, model: selected.model, candidates, blocked };
		const resets = blocked.flatMap((item) => (item.resetAt === undefined ? [] : [item.resetAt]));
		return { ok: false, blocked, resetAt: resets.length ? Math.min(...resets) : undefined };
	}

	/**
	 * Usage read for `model`'s provider taken after `failedAt` (the failure's
	 * timestamp); marks and returns true only when it shows `model` blocked. A
	 * failed, stale, or cancelled read confirms nothing.
	 */
	async confirm(model: Model<Api>, env: RouteEnv, signal: AbortSignal | undefined, failedAt: number): Promise<boolean> {
		const decision = await env.refresh(model, signal, failedAt);
		if (!decision?.block || signal?.aborted) return false;
		this.tracker.mark(model, decision);
		return true;
	}

	/**
	 * Route one request (see `ModelRouteReason`):
	 * - ordered `user`, `direct`: first eligible entry
	 * - balanced `user`: score eligible entries with incumbent hysteresis
	 * - `continuation`, balanced `direct`: keep eligible `previous`, otherwise select
	 * - `retry`: confirmed quota reselects an eligible entry; anything else retries the failed model
	 */
	async route(profile: Profile, request: ModelRouteRequest, env: RouteEnv): Promise<ModelRoute> {
		request.signal?.throwIfAborted();
		const { reason, previous, failed } = request;
		if (reason === "retry" && failed) {
			const entry = profile.chain.find((item) => sameModel(item, failed.model));
			if (entry) {
				const confirmed =
					isQuotaError(failed.message) &&
					(await this.confirm(failed.model, env, request.signal, failed.message.timestamp));
				request.signal?.throwIfAborted();
				if (!confirmed) return this.toRoute(entry, failed.model, request.thinkingLevel);
				if (hasPartialOutput(failed.message)) {
					throw new Error("subscription-router: refusing to replay a partial response; retry explicitly.");
				}
			}
		}
		if ((reason === "continuation" || (reason === "direct" && profile.strategy === "balanced")) && previous) {
			const entry = profile.chain.find((item) => sameModel(item, previous.model));
			if (entry && !this.blockedBy(previous.model)) {
				const model = env.resolve(entry);
				if (model) return this.toRoute(entry, model, request.thinkingLevel);
			}
		}
		const picked = this.pick(
			profile,
			env,
			reason === "user" && profile.strategy === "balanced" ? previous?.model : undefined,
		);
		if (!picked.ok) throw new ChainExhaustedError(profile.id, picked.blocked, picked.resetAt);
		this.onDecision?.({
			at: this.now(),
			profile: profile.id,
			strategy: profile.strategy ?? "ordered",
			reason,
			chosen: refKey(picked.entry),
			candidates: picked.candidates.map((c) => ({
				model: refKey(c.entry),
				quota: c.score,
				...(c.ageMs === undefined ? {} : { ageMs: c.ageMs }),
			})),
			blocked: picked.blocked.map((b) => ({ model: refKey(b.entry), reason: b.reason })),
		});
		return this.toRoute(picked.entry, picked.model, request.thinkingLevel);
	}

	private toRoute(entry: ChainEntry, model: Model<Api>, selected: ModelThinkingLevel): ModelRoute {
		return { model, thinkingLevel: entry.thinking ?? selected };
	}
}
