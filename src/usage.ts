/**
 * OAuth-backed subscription usage: the Anthropic and ChatGPT Codex collectors,
 * a normalized per-provider cache, and the per-model block decision built on it.
 *
 * Ported from the nredd/pi-subagents fork (`src/subscription-usage.ts`), minus
 * the cross-extension collector registry and provider aliases, which had no user.
 *
 * Fetching is deliberately conservative: successful reads are cached for five
 * minutes, `fresh` reads within a minute share one response, and a failed read
 * backs the provider off (1m, 2m, 5m, then 15m) so a throttled endpoint is not
 * hammered. OAuth secrets never leave this module.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ModelRef, refKey } from "./model-ref.js";

/** How long a successful read is served from cache to plain `get` calls. */
const CACHE_TTL_MS = 5 * 60_000;
/** Minimum spacing between user-initiated (`force`) refreshes per provider. */
const MANUAL_REFRESH_INTERVAL_MS = 60_000;
/** A `fresh` read reuses a snapshot retrieved this recently, so concurrent confirmations share one read. */
const FRESH_REUSE_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Failure backoff steps; the last entry is the cap. Reset on the next success. */
const FAILURE_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000] as const;
/** Upper bound on a server-supplied `Retry-After`, so a bogus header cannot park a provider for days. */
const RETRY_AFTER_CEILING_MS = 60 * 60_000;
/** Numeric reset times below this are Unix seconds, above it milliseconds (1e11 s is the year 5138). */
const SECONDS_VS_MS_THRESHOLD = 100_000_000_000;
/** Beta flag the Anthropic usage endpoint requires for OAuth bearer tokens. */
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
/** Requests without a claude-code User-Agent land in an aggressively 429'd bucket (anthropics/claude-code#31637). */
const ANTHROPIC_USER_AGENT = "claude-code/2.1";
/** Anthropic console API keys have no subscription window to report. */
const ANTHROPIC_API_KEY_PREFIX = "sk-ant-api";
/** JWT claim namespace carrying the ChatGPT account id in Codex access tokens. */
const CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** `available`: fresh data. `stale`: old data kept after an expiry or failed refresh. */
export type UsageStatus = "available" | "stale" | "unavailable" | "error";

/** One normalized quota window. */
export interface UsageWindow {
	/** Provider-native window name, e.g. `five_hour`, `seven_day_opus`, `5h`. */
	name: string;
	/** 0-100; values over 100 are clamped so over-limit still blocks. */
	usedPercent: number;
	/** Epoch milliseconds, when known. */
	resetAt?: number;
	/** Full quota-window duration in milliseconds, when known. */
	durationMs?: number;
	/**
	 * Provenance of `name` and `durationMs`, for display only (never read by scoring or admission).
	 * `reported`: the provider stated the span (Anthropic's fixed windows, Codex `limit_window_seconds`).
	 * `assumed`: guessed from position because the provider stated none. Absent on older snapshots.
	 */
	spanSource?: "reported" | "assumed";
	/** `provider` windows gate every model; `model` windows gate only matching `families`. */
	scope: "provider" | "model";
	/** Family tokens a `model`-scoped window applies to, e.g. `["opus"]`. See `modelMatchesFamily`. */
	families?: string[];
}

/** Normalized quota state for one provider at one point in time. */
export interface UsageSnapshot {
	provider: string;
	status: UsageStatus;
	windows: UsageWindow[];
	/** Paid credits. Only `unlimited` affects decisions; a balance never bypasses a window. */
	credits?: { available: boolean; unlimited: boolean; balance?: string };
	retrievedAt: number;
	expiresAt: number;
	message?: string;
}

/** Side-effecting dependencies, injectable for tests. */
export interface UsageTransport {
	fetch(input: string, init: RequestInit): Promise<Response>;
	now(): number;
	getAccessToken(ctx: ExtensionContext, provider: string): Promise<string | undefined>;
}

interface ParsedUsage {
	windows: UsageWindow[];
	credits?: UsageSnapshot["credits"];
}

/** A usage endpoint for one subscription provider. */
interface Collector {
	url: string;
	headers(token: string): Record<string, string>;
	/** Normalize a 2xx JSON payload; `undefined` marks an unsupported shape. */
	parse(payload: unknown): ParsedUsage | undefined;
	/** False for credentials the endpoint cannot serve (e.g. API keys); no request is made. */
	acceptsToken?(token: string): boolean;
}

/** Whether a model must not be dispatched on included quota right now, and why. */
export interface UsageDecision {
	block: boolean;
	message?: string;
	window?: string;
	resetAt?: number;
	/** Scope of the exhausted window: which models the block also covers. */
	scope?: "provider" | "model";
	families?: string[];
}

/**
 * True when `family` appears in `modelId` as a whole token: bounded on each side
 * by the string edge or one of `-./:`, case-insensitive. `opus` matches
 * `claude-opus-4-1` and `us.anthropic.claude-opus-4-1-v1:0`, not `claude-magnopus`.
 */
export function modelMatchesFamily(modelId: string, family: string): boolean {
	const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[-./:])${escaped}(?:$|[-./:])`, "i").test(modelId);
}

function errorSnapshot(provider: string, status: "error" | "unavailable", now: number, message: string): UsageSnapshot {
	return { provider, status, windows: [], retrievedAt: now, expiresAt: now, message };
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Epoch ms from Unix seconds, epoch ms, or an RFC 3339 / HTTP-date string. */
function timestamp(value: unknown): number | undefined {
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	const raw = finiteNumber(value);
	if (raw === undefined) return undefined;
	const ms = raw < SECONDS_VS_MS_THRESHOLD ? raw * 1000 : raw;
	return Number.isNaN(new Date(ms).getTime()) ? undefined : ms;
}

function percentage(value: unknown): number | undefined {
	const raw = finiteNumber(value);
	if (raw === undefined || raw < 0) return undefined;
	return Math.min(raw, 100);
}

function isoMinute(epochMs: number): string {
	return `${new Date(epochMs).toISOString().slice(0, 16)}Z`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Parse the Anthropic `/api/oauth/usage` payload. */
export function parseAnthropic(payload: unknown): ParsedUsage | undefined {
	const root = asRecord(payload);
	if (!root) return undefined;
	const windows: UsageWindow[] = [];
	const specs = [
		["five_hour", undefined],
		["seven_day", undefined],
		["seven_day_opus", ["opus"]],
		["seven_day_sonnet", ["sonnet"]],
	] as const;
	for (const [key, families] of specs) {
		const item = asRecord(root[key]);
		if (!item) continue;
		const usedPercent = percentage(item.utilization ?? item.used_percentage);
		if (usedPercent === undefined) continue;
		windows.push({
			name: key,
			usedPercent,
			resetAt: timestamp(item.resets_at ?? item.reset_at),
			durationMs: key === "five_hour" ? 18_000_000 : 604_800_000,
			spanSource: "reported",
			scope: families ? "model" : "provider",
			families: families ? [...families] : undefined,
		});
	}
	return windows.length === 0 ? undefined : { windows };
}

/** Parse the ChatGPT Codex `wham/usage` payload. */
export function parseCodex(payload: unknown): ParsedUsage | undefined {
	const root = asRecord(payload);
	const limits = asRecord(root?.rate_limit);
	if (!root || !limits) return undefined;
	const windows: UsageWindow[] = [];
	for (const [key, name] of [
		["primary_window", "5h"],
		["secondary_window", "7d"],
	] as const) {
		const item = asRecord(limits[key]);
		if (!item) continue;
		const usedPercent = percentage(item.used_percent);
		if (usedPercent === undefined) continue;
		// Plans can expose a weekly primary window with no secondary window.
		// Prefer the reported duration; positional names are legacy fallbacks only.
		const duration = finiteNumber(item.limit_window_seconds);
		const windowName =
			duration === 604_800 ? "7d" : duration === 18_000 ? "5h" : duration && duration > 0 ? `${duration}s` : name;
		windows.push({
			name: windowName,
			usedPercent,
			resetAt: timestamp(item.reset_at),
			scope: "provider",
			durationMs: duration && duration > 0 ? duration * 1000 : key === "primary_window" ? 18_000_000 : 604_800_000,
			spanSource: duration && duration > 0 ? "reported" : "assumed",
		});
	}
	if (windows.length === 0) return undefined;
	const credits = asRecord(root.credits);
	if (!credits) return { windows };
	return {
		windows,
		credits: {
			available: credits.has_credits === true,
			unlimited: credits.unlimited === true,
			balance: typeof credits.balance === "string" ? credits.balance : undefined,
		},
	};
}

/** `chatgpt_account_id` from a Codex access-token JWT, or undefined when not decodable. */
function codexAccountId(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		const payload = asRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")));
		const accountId = asRecord(payload?.[CODEX_JWT_CLAIM_PATH])?.chatgpt_account_id;
		return typeof accountId === "string" && accountId ? accountId : undefined;
	} catch {
		return undefined;
	}
}

const COLLECTORS: Readonly<Record<string, Collector>> = {
	anthropic: {
		url: "https://api.anthropic.com/api/oauth/usage",
		headers: (token) => ({
			Authorization: `Bearer ${token}`,
			"anthropic-beta": ANTHROPIC_OAUTH_BETA,
			"User-Agent": ANTHROPIC_USER_AGENT,
		}),
		parse: parseAnthropic,
		acceptsToken: (token) => !token.startsWith(ANTHROPIC_API_KEY_PREFIX),
	},
	"openai-codex": {
		url: "https://chatgpt.com/backend-api/wham/usage",
		headers: (token): Record<string, string> => {
			const accountId = codexAccountId(token);
			return accountId
				? { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId }
				: { Authorization: `Bearer ${token}` };
		},
		parse: parseCodex,
	},
};

/** Providers with a usage collector. */
export const COLLECTED_PROVIDERS: readonly string[] = Object.keys(COLLECTORS);

/** `Retry-After` as milliseconds from `now`: delta-seconds or an HTTP-date. */
function retryAfterMs(header: string | null, now: number): number | undefined {
	if (!header) return undefined;
	const trimmed = header.trim();
	const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
	return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

interface FetchOutcome {
	snapshot: UsageSnapshot;
	/** True when a network read was attempted and failed; drives the backoff. */
	failed: boolean;
	retryAfterMs?: number;
}

/** Options for `UsageService.get`. */
export interface UsageGetOptions {
	/** User-initiated; limited to once per minute per provider. */
	force?: boolean;
	/** Bypass the TTL, but reuse a read from the last minute. */
	fresh?: boolean;
	/**
	 * Epoch ms. Reuse a cached or in-flight read only if it started at or after
	 * this, e.g. the failure a confirmation is about. Concurrent confirmations of
	 * the same failure still share one request.
	 */
	notBefore?: number;
	/** Detaches only this caller; a shared in-flight read continues. */
	signal?: AbortSignal;
}

/** Initiation-ordered reads retain local evidence without publishing superseded results. */
interface UsageRead {
	startedAt: number;
	read: Promise<UsageSnapshot>;
	snapshot?: UsageSnapshot;
	newer?: UsageRead;
}

/** Subscription quota state for OAuth-backed consumer plans. */
export class UsageService {
	private readonly cache = new Map<string, UsageSnapshot>();
	private readonly lastManualRefreshAt = new Map<string, number>();
	private readonly inFlight = new Map<string, UsageRead>();
	private readonly backoff = new Map<string, { failures: number; until: number }>();

	constructor(
		private readonly transport: UsageTransport = {
			fetch,
			now: () => Date.now(),
			getAccessToken: (ctx, provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
		},
	) {}

	/**
	 * Current usage for `provider`: cached while younger than five minutes, else a
	 * network read (see `UsageGetOptions` for `fresh` and `force`). During failure
	 * backoff nothing touches the network: the last snapshot comes back `stale`,
	 * or an `error` snapshot when there is none. Never rejects.
	 */
	async get(ctx: ExtensionContext, provider: string, options: UsageGetOptions = {}): Promise<UsageSnapshot> {
		const now = this.transport.now();
		if (options.signal?.aborted) return errorSnapshot(provider, "error", now, "Usage request was cancelled.");
		const cached = this.cache.get(provider);
		const force = options.force === true;
		if (!force && cached?.status === "available") {
			if (!options.fresh && cached.expiresAt > now) return cached;
			const reusable = options.notBefore === undefined || cached.retrievedAt >= options.notBefore;
			if (options.fresh && reusable && now - cached.retrievedAt < FRESH_REUSE_WINDOW_MS) return cached;
		}
		const backoff = this.backoff.get(provider);
		if (backoff && backoff.until > now) {
			const until = new Date(backoff.until).toISOString();
			return this.withStale(cached, provider, now, `Backing off after a failed usage request until ${until}.`);
		}
		if (force) {
			if (now - (this.lastManualRefreshAt.get(provider) ?? 0) < MANUAL_REFRESH_INTERVAL_MS) {
				return this.withStale(cached, provider, now, "Manual refresh is limited to once per minute.");
			}
			this.lastManualRefreshAt.set(provider, now);
		}
		const refresh = this.refresh(ctx, provider, now, options.notBefore);
		const snapshot = await waitForCaller(refresh.read, options.signal, () => {
			// The one outer deadline owns fallback selection. Inner waits must not
			// race it with separate timers or extend it for each newer owner.
			let fallback: UsageSnapshot | undefined;
			const consider = (candidate: UsageSnapshot | undefined) => {
				if (
					candidate?.status === "available" &&
					candidate.retrievedAt >= Math.max(refresh.startedAt, options.notBefore ?? refresh.startedAt) &&
					(!fallback || candidate.retrievedAt >= fallback.retrievedAt)
				)
					fallback = candidate;
			};
			for (let entry: UsageRead | undefined = refresh; entry; entry = entry.newer) consider(entry.snapshot);
			consider(this.cache.get(provider));
			return fallback;
		});
		if (!snapshot) {
			return errorSnapshot(
				provider,
				"error",
				now,
				options.signal?.aborted ? "Usage request was cancelled." : "Usage request timed out.",
			);
		}
		return snapshot;
	}

	/** Cached snapshot without any network read; expired data is reported `stale`. */
	peek(provider: string): UsageSnapshot | undefined {
		const cached = this.cache.get(provider);
		if (!cached) return undefined;
		const now = this.transport.now();
		return cached.expiresAt > now ? cached : this.withStale(cached, provider, now, "Cached usage data is stale.");
	}

	/**
	 * Whether `model` is blocked on included quota, from cached data only. Blocks
	 * when a matching window is exhausted in fresh data, or in stale data whose
	 * known reset is still ahead (staleness cannot refill a window early). Stale
	 * data with an unknown or past reset, missing data, and failed reads fail open.
	 * An unlimited plan never blocks; a credit balance never bypasses a window.
	 */
	decisionFor(model: ModelRef, snapshot = this.peek(model.provider)): UsageDecision {
		if (!snapshot || (snapshot.status !== "available" && snapshot.status !== "stale")) return { block: false };
		if (snapshot.credits?.unlimited === true) return { block: false };
		const now = this.transport.now();
		const exhausted = snapshot.windows.find(
			(window) =>
				window.usedPercent >= 100 &&
				(window.scope === "provider" ||
					window.families?.some((family) => modelMatchesFamily(model.id, family)) === true) &&
				(window.resetAt === undefined ? snapshot.status === "available" : window.resetAt > now),
		);
		if (!exhausted) return { block: false };
		const reset = exhausted.resetAt ? new Date(exhausted.resetAt).toISOString() : "an unknown time";
		return {
			block: true,
			window: exhausted.name,
			resetAt: exhausted.resetAt,
			scope: exhausted.scope,
			families: exhausted.families,
			message: `${refKey(model)}: ${exhausted.name} is exhausted and resets ${reset}.`,
		};
	}

	/** Human-readable one-liner for UI and tool output. */
	format(snapshot: UsageSnapshot | undefined): string {
		if (!snapshot) return "usage unavailable (not checked)";
		if (snapshot.status !== "available") return `usage ${snapshot.status}: ${snapshot.message ?? "not available"}`;
		return snapshot.windows
			.map((window) => {
				const reset = window.resetAt ? `, resets ${new Date(window.resetAt).toLocaleTimeString()}` : "";
				return `${window.name} ${Math.round(window.usedPercent)}% used${reset}`;
			})
			.join("; ");
	}

	/**
	 * System-prompt rendering with coarse 25% buckets and UTC minute resets only for
	 * exhausted windows, so the text (and the prompt-cache prefix) stays stable
	 * across ordinary turns. Stale snapshots keep their last-known windows.
	 */
	formatForPrompt(snapshot: UsageSnapshot | undefined): string {
		if (!snapshot) return "usage unavailable";
		if (snapshot.windows.length === 0) return `usage ${snapshot.status}`;
		return snapshot.windows
			.map((window) => {
				const used = window.usedPercent;
				const bucket =
					used >= 100
						? window.resetAt
							? `exhausted until ${isoMinute(window.resetAt)}`
							: "exhausted, reset unknown"
						: used < 25
							? "<25%"
							: used < 50
								? "25-50%"
								: used < 75
									? "50-75%"
									: "75-100%";
				return `${window.name} ${bucket}`;
			})
			.join("; ");
	}

	private withStale(
		cached: UsageSnapshot | undefined,
		provider: string,
		now: number,
		message: string | undefined,
	): UsageSnapshot {
		if (!cached) return errorSnapshot(provider, "error", now, message ?? "No cached usage data.");
		return { ...cached, status: "stale", expiresAt: now, message };
	}

	private refresh(ctx: ExtensionContext, provider: string, now: number, notBefore?: number): UsageRead {
		const existing = this.inFlight.get(provider);
		if (existing && (notBefore === undefined || existing.startedAt >= notBefore)) return existing;
		const refresh = this.fetchSnapshot(ctx, provider, now)
			.then(async (outcome) => {
				entry.snapshot = outcome.snapshot;
				// A post-failure read may supersede a slow warm-up. Only the newest
				// initiated read owns cache/backoff writes, regardless of completion order.
				if (this.inFlight.get(provider)?.read !== refresh) {
					// Follow only later owners, never older reads: the dependency graph
					// is acyclic. The caller's total wait is bounded across supersessions.
					const newer = this.inFlight.get(provider);
					const latest = newer ? await newer.read : this.cache.get(provider);
					const freshEnough = (snapshot: UsageSnapshot | undefined): snapshot is UsageSnapshot =>
						snapshot?.status === "available" && snapshot.retrievedAt >= Math.max(now, notBefore ?? now);
					if (freshEnough(latest)) return latest;
					// This caller can use its exact live result, but must not overwrite
					// the newer owner's cache or clear the newer failure's backoff.
					if (freshEnough(outcome.snapshot)) return outcome.snapshot;
					if (latest) return latest;
					return errorSnapshot(
						provider,
						"error",
						this.transport.now(),
						"Usage request was superseded by a newer read.",
					);
				}
				if (outcome.snapshot.status === "available") {
					this.cache.set(provider, outcome.snapshot);
					this.backoff.delete(provider);
				} else if (outcome.failed) {
					this.recordFailure(provider, outcome.retryAfterMs);
				}
				const cached = this.cache.get(provider);
				if (outcome.snapshot.status !== "available" && cached) {
					const stale = this.withStale(cached, provider, this.transport.now(), outcome.snapshot.message);
					this.cache.set(provider, stale);
					return stale;
				}
				return outcome.snapshot;
			})
			.finally(() => {
				if (this.inFlight.get(provider)?.read === refresh) this.inFlight.delete(provider);
			});
		const entry: UsageRead = { startedAt: now, read: refresh };
		if (existing) existing.newer = entry;
		this.inFlight.set(provider, entry);
		return entry;
	}

	private recordFailure(provider: string, retryAfter: number | undefined): void {
		const failures = (this.backoff.get(provider)?.failures ?? 0) + 1;
		const step = FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1] ?? 0;
		const delay = Math.min(Math.max(step, retryAfter ?? 0), RETRY_AFTER_CEILING_MS);
		this.backoff.set(provider, { failures, until: this.transport.now() + delay });
	}

	private async fetchSnapshot(ctx: ExtensionContext, provider: string, now: number): Promise<FetchOutcome> {
		const unfetched = (status: "error" | "unavailable", message: string): FetchOutcome => ({
			snapshot: errorSnapshot(provider, status, now, message),
			failed: false,
		});
		const collector = Object.hasOwn(COLLECTORS, provider) ? COLLECTORS[provider] : undefined;
		if (!collector) return unfetched("unavailable", "No subscription usage collector exists for this provider.");
		let token: string | undefined;
		const lookupTimedOut = Symbol("credential lookup timeout");
		let lookupTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			// Core owns refresh/persistence. Bound only our wait; its API has no
			// cancellation parameter, so a late owner result is ignored, not aborted.
			const result = await Promise.race([
				this.transport.getAccessToken(ctx, provider),
				new Promise<typeof lookupTimedOut>((resolve) => {
					lookupTimer = setTimeout(() => resolve(lookupTimedOut), REQUEST_TIMEOUT_MS);
				}),
			]);
			if (result === lookupTimedOut) {
				return { ...unfetched("error", "OAuth credential lookup timed out."), failed: true };
			}
			token = result;
		} catch {
			return unfetched("error", "OAuth credential lookup failed.");
		} finally {
			clearTimeout(lookupTimer);
		}
		if (!token) return unfetched("unavailable", "No OAuth credential is available for this provider.");
		if (collector.acceptsToken?.(token) === false) {
			return unfetched("unavailable", "API-key auth has no subscription usage window.");
		}

		const failure = (message: string, retryAfter?: number): FetchOutcome => ({
			snapshot: errorSnapshot(provider, "error", now, message),
			failed: true,
			retryAfterMs: retryAfter,
		});
		const controller = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, REQUEST_TIMEOUT_MS);
		try {
			const response = await this.transport.fetch(collector.url, {
				headers: collector.headers(token),
				signal: controller.signal,
			});
			if (!response.ok) {
				return failure(
					`Usage request failed (${response.status}).`,
					retryAfterMs(response.headers.get("retry-after"), this.transport.now()),
				);
			}
			const parsed = collector.parse(await response.json());
			if (!parsed) return failure("Usage response had an unsupported shape.");
			return {
				snapshot: { provider, status: "available", retrievedAt: now, expiresAt: now + CACHE_TTL_MS, ...parsed },
				failed: false,
			};
		} catch (error) {
			const aborted = error instanceof Error && error.name === "AbortError";
			if (aborted) return failure(timedOut ? "Usage request timed out." : "Usage request was cancelled.");
			return failure("Usage request failed.");
		} finally {
			clearTimeout(timeout);
		}
	}
}

/** Prefer the completed read; at the total deadline use live evidence, never on abort. */
function waitForCaller(
	refresh: Promise<UsageSnapshot>,
	signal: AbortSignal | undefined,
	onTimeout: () => UsageSnapshot | undefined,
): Promise<UsageSnapshot | undefined> {
	if (signal?.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (snapshot?: UsageSnapshot) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve(snapshot);
		};
		const abort = () => finish();
		// One credential lookup plus one fetch, regardless of supersession count.
		const timer = setTimeout(() => finish(signal?.aborted ? undefined : onTimeout()), 2 * REQUEST_TIMEOUT_MS);
		signal?.addEventListener("abort", abort, { once: true });
		void refresh.then(finish);
	});
}
