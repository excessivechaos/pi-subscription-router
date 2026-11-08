/**
 * Quota window kick: a subscription 5-hour window only starts when a request is
 * made, so a window nobody uses never runs and its reset time never advances.
 * When a poll shows that the window we last saw ahead of us has passed its
 * reset instant, the kicker sends one minimal completion — one output token,
 * reasoning disabled, no tools, no session message — on the provider's cheapest
 * chat model, so the next window starts and its 5-hour clock begins.
 *
 * Every provider is handled once per reset epoch: the epoch is persisted in
 * `<agentDir>/router-window-kicks.json`, so a restart (or a second session in
 * the same process, which shares this object) never re-kicks it. A kick is
 * suppressed when the session itself has already served a request since the
 * reset (that request started the window), when one arrived within `quietMs`,
 * and always by the per-UTC-day `maxPerDay` cap. Nothing here throws into the
 * session: every failure is recorded as an `error` entry instead.
 */

import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WindowKickConfig } from "./config.js";
import { parseRef, refKey } from "./model-ref.js";
import type { UsageSnapshot, UsageWindow } from "./usage.js";

/** Persisted state file in the agent dir. */
export const KICK_FILE = "router-window-kicks.json";
/** Session entry type carrying one `WindowKickEntry`. */
export const KICK_ENTRY = "window-kick";
/** Hard bound on one kick; a stuck request must never outlive the poll that started it. */
export const KICK_TIMEOUT_MS = 10_000;
/** Span of the quota window a kick exists to start. */
const FIVE_HOUR_MS = 18_000_000;
/** Text of the one message a kick sends. */
const KICK_TEXT = "ok";

/** One provider's persisted kick history. */
export interface WindowKickState {
	/** Reset instant (epoch ms) of the last window this record handled, once it had elapsed. */
	lastResetAt?: number;
	/** When the last kick attempt was issued. */
	kickedAt?: number;
	/** Last real session request seen for the provider. */
	lastRequestAt?: number;
	/** Outcome of the last issued attempt (`ok` or `error`); skips are session entries only. */
	lastOutcome?: string;
	/** Issued attempts per UTC day, `YYYY-MM-DD` -> count. */
	perDay: Record<string, number>;
}

/** Every provider's kick history. */
export type WindowKickStore = Record<string, WindowKickState>;

/** The session entry each kick decision records. */
export interface WindowKickEntry {
	kind: "window-kick";
	provider: string;
	/** `provider/id` of the model the kick used; empty when none resolved. */
	model: string;
	/** The reset epoch the kick is anchored to; the kick time when no window is known (manual kick). */
	resetAt: number;
	outcome: "ok" | "error" | `skipped:${string}`;
	/** Failure text, for `error` and the skips that name a reason. */
	detail?: string;
	/** Token usage and cost of a successful kick. */
	usage?: Usage;
}

/** Host operations a kick needs; the extension binds them to one session context. */
export interface KickSession {
	/** The model to kick with, or undefined when no candidate has credentials. */
	resolve(provider: string): Model<Api> | undefined;
	/** One minimal completion outside the session. Must reject on failure. */
	complete(model: Model<Api>, signal: AbortSignal): Promise<AssistantMessage>;
	/** Append a session entry. Must not throw. */
	record(entry: WindowKickEntry): void;
}

/** The slice of `ModelRegistry` model selection needs. */
export interface KickRegistry {
	getAll(): Model<Api>[];
	hasConfiguredAuth(model: Model<Api>): boolean;
	find(provider: string, id: string): Model<Api> | undefined;
}

/** The 5-hour window of a snapshot, when the provider reports one. */
export function fiveHourWindow(windows: readonly UsageWindow[]): UsageWindow | undefined {
	return windows.find(
		(window) =>
			window.scope === "provider" &&
			(window.name === "5h" || window.name === "five_hour" || window.durationMs === FIVE_HOUR_MS),
	);
}

/**
 * The model a kick uses for `provider`: the configured override, else the
 * provider's cheapest chat model by input + output price (ties by id). A model
 * without credentials is no candidate, exactly as routing treats it.
 */
export function kickModel(registry: KickRegistry, provider: string, config: WindowKickConfig): Model<Api> | undefined {
	const override = config.providers[provider];
	if (override !== undefined) {
		const ref = parseRef(override);
		const model = ref && ref.provider === provider ? registry.find(ref.provider, ref.id) : undefined;
		return model && registry.hasConfiguredAuth(model) ? model : undefined;
	}
	const candidates = registry
		.getAll()
		.filter((model) => model.provider === provider && (model.type === undefined || model.type === "chat"))
		.filter((model) => registry.hasConfiguredAuth(model))
		.sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output) || a.id.localeCompare(b.id));
	return candidates[0];
}

/** What a kick sends: one short user message, no tools and no system prompt of ours. */
export function kickContext(now: number): Context {
	return { messages: [{ role: "user", content: [{ type: "text", text: KICK_TEXT }], timestamp: now }] };
}

/**
 * `complete()` options for a kick: one output token, no retries, and the
 * provider-native reasoning switch off. `complete()` takes provider options
 * rather than a thinking level, so the switch is the adapter's own.
 */
export function kickOptions(model: Model<Api>, signal: AbortSignal): Record<string, unknown> {
	return {
		maxTokens: 1,
		maxRetries: 0,
		signal,
		...(model.api === "anthropic-messages" ? { thinkingEnabled: false } : {}),
		...(model.api === "openai-codex-responses" ? { reasoningEffort: "none" } : {}),
	};
}

/** `HH:MMZ` of an instant, the form `/router status` prints. */
export function kickClock(at: number): string {
	return `${new Date(at).toISOString().slice(11, 16)}Z`;
}

/** UTC day key of `at`. */
function utcDay(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One observation of a provider's 5-hour window. */
interface WindowObservation {
	resetAt?: number;
	usedPercent: number;
	/** When the provider reported it, so "was the reset ahead of us" is judged on its own clock. */
	observedAt: number;
}

/** Write the whole store atomically: a crash mid-write must not lose the epoch guard. */
async function writeStore(path: string, store: WindowKickStore): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

/** The per-provider reset-epoch tracker and kicker. */
export class WindowKick {
	private readonly config: WindowKickConfig;
	private readonly statePath: string;
	private readonly now: () => number;
	private readonly state: WindowKickStore = {};
	private readonly seen = new Map<string, WindowObservation>();
	/** Requests observed in this process; merged into the store whenever it is written. */
	private readonly requests = new Map<string, number>();
	/** Session entries already appended for a skip, one per provider/epoch/reason. */
	private readonly reported = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly loaded: Promise<void>;
	private writes: Promise<void> = Promise.resolve();

	constructor(options: { config: WindowKickConfig; statePath: string; now?: () => number }) {
		this.config = options.config;
		this.statePath = options.statePath;
		this.now = options.now ?? Date.now;
		this.loaded = this.load();
	}

	/** Read the persisted history once; a missing or unreadable file is an empty history. */
	private async load(): Promise<void> {
		try {
			const raw: unknown = JSON.parse(await readFile(this.statePath, "utf-8"));
			if (!isRecord(raw)) return;
			for (const [provider, value] of Object.entries(raw)) {
				if (!isRecord(value)) continue;
				const perDay: Record<string, number> = {};
				if (isRecord(value.perDay)) {
					for (const [day, count] of Object.entries(value.perDay)) {
						if (typeof count === "number" && Number.isFinite(count)) perDay[day] = count;
					}
				}
				this.state[provider] = {
					perDay,
					...(typeof value.lastResetAt === "number" ? { lastResetAt: value.lastResetAt } : {}),
					...(typeof value.kickedAt === "number" ? { kickedAt: value.kickedAt } : {}),
					...(typeof value.lastRequestAt === "number" ? { lastRequestAt: value.lastRequestAt } : {}),
					...(typeof value.lastOutcome === "string" ? { lastOutcome: value.lastOutcome } : {}),
				};
			}
		} catch {
			// No history yet, or a torn file: kicking once more is harmless, failing a session is not.
		}
	}

	/** Resolves once the persisted history is loaded. */
	async ready(): Promise<void> {
		await this.loaded;
	}

	/**
	 * A real request to `provider` was served. It starts the window by itself, so
	 * it cancels a pending kick; persisted lazily with the next state write.
	 */
	noteRequest(provider: string, at: number = this.now()): void {
		this.requests.set(provider, Math.max(this.requests.get(provider) ?? 0, at));
	}

	/**
	 * Observe one usage snapshot. Kicks when the 5-hour reset instant we last saw
	 * ahead of us (or an exhausted window's own reset) has passed, and returns the
	 * recorded entry; undefined when there is nothing to do.
	 */
	async observe(
		snapshot: UsageSnapshot,
		session: KickSession,
		signal?: AbortSignal,
	): Promise<WindowKickEntry | undefined> {
		await this.loaded;
		const now = this.now();
		const window = fiveHourWindow(snapshot.windows);
		const previous = this.seen.get(snapshot.provider);
		if (window) {
			this.seen.set(snapshot.provider, {
				resetAt: window.resetAt,
				usedPercent: window.usedPercent,
				observedAt: snapshot.retrievedAt,
			});
		} else this.seen.delete(snapshot.provider);
		if (!this.config.enabled) return undefined;
		// A crossing is the reset we saw ahead of us now being behind us. The
		// provider may already have dropped the window from its report, and an
		// exhausted window seen only after its reset is the same evidence with no
		// earlier observation (a restart, or a window that sat at 100%).
		const previousEpoch =
			previous?.resetAt !== undefined && previous.resetAt > previous.observedAt && previous.resetAt <= now
				? previous.resetAt
				: undefined;
		const currentEpoch =
			window?.resetAt !== undefined && window.usedPercent >= 100 && window.resetAt <= now ? window.resetAt : undefined;
		const epoch = previousEpoch ?? currentEpoch;
		if (epoch === undefined) return undefined;
		if (this.state[snapshot.provider]?.lastResetAt === epoch) return undefined;
		return this.attempt(snapshot.provider, epoch, session, signal, false);
	}

	/**
	 * Issue one kick now, bypassing the quiet, request and daily-cap gates: the
	 * `/router kick <provider>` path. Still records the entry and the state.
	 */
	async manual(provider: string, session: KickSession, signal?: AbortSignal): Promise<WindowKickEntry> {
		await this.loaded;
		const now = this.now();
		const seen = this.seen.get(provider);
		// A manual kick inside a running window anchors on nothing: only an elapsed
		// reset instant may claim an epoch, or the boundary kick would be suppressed.
		const epoch = seen?.resetAt !== undefined && seen.resetAt <= now ? seen.resetAt : undefined;
		return this.attempt(provider, epoch, session, signal, true);
	}

	/** One line for `/router status`: `anthropic 20:39Z ok, openai-codex —`. */
	async describe(): Promise<string> {
		await this.loaded;
		const providers = Object.keys(this.config.providers);
		if (providers.length === 0) return "no providers configured";
		return providers
			.map((provider) => {
				const record = this.state[provider];
				const at = record?.lastResetAt ?? record?.kickedAt;
				return at === undefined ? `${provider} —` : `${provider} ${kickClock(at)} ${record?.lastOutcome ?? "—"}`;
			})
			.join(", ");
	}

	/** Record one entry, persist an issued attempt, and return it. */
	private finish(
		session: KickSession,
		entry: WindowKickEntry,
		options: { issued: boolean; dedupe: boolean; claimEpoch: boolean },
	): WindowKickEntry {
		const record = (this.state[entry.provider] ??= { perDay: {} });
		if (options.issued) {
			record.lastOutcome = entry.outcome;
			// A failed kick does not claim the epoch: the next poll retries, capped by `maxPerDay`.
			if (options.claimEpoch && entry.outcome === "ok") record.lastResetAt = entry.resetAt;
			this.save();
		}
		const key = `${entry.provider}:${entry.resetAt}:${entry.outcome}`;
		if (!options.issued && options.dedupe && this.reported.has(key)) return entry;
		this.reported.add(key);
		session.record(entry);
		return entry;
	}

	private async attempt(
		provider: string,
		epoch: number | undefined,
		session: KickSession,
		signal: AbortSignal | undefined,
		manual: boolean,
	): Promise<WindowKickEntry> {
		const record = (this.state[provider] ??= { perDay: {} });
		const now = this.now();
		const claimEpoch = epoch !== undefined;
		const entry = (outcome: WindowKickEntry["outcome"], model: string, extra: Partial<WindowKickEntry> = {}) => ({
			kind: "window-kick" as const,
			provider,
			model,
			resetAt: epoch ?? now,
			outcome,
			...extra,
		});
		const skip = (outcome: `skipped:${string}`, model = this.config.providers[provider] ?? "") =>
			this.finish(session, entry(outcome, model), { issued: false, dedupe: !manual, claimEpoch });
		const model = session.resolve(provider);
		if (!model) return skip("skipped:no-model");
		const label = refKey(model);
		if (this.inFlight.has(provider)) return skip("skipped:in-flight", label);
		const lastRequest = Math.max(record.lastRequestAt ?? 0, this.requests.get(provider) ?? 0);
		if (!manual && epoch !== undefined && lastRequest >= epoch) return skip("skipped:recent-request", label);
		if (!manual && now - lastRequest < this.config.quietMs) return skip("skipped:quiet", label);
		const today = utcDay(now);
		if (!manual && (record.perDay[today] ?? 0) >= this.config.maxPerDay) return skip("skipped:daily-cap", label);
		// Count the attempt before sending: the cap bounds requests, not successes.
		record.perDay[today] = (record.perDay[today] ?? 0) + 1;
		record.kickedAt = now;
		this.save();
		this.inFlight.add(provider);
		const timeout = AbortSignal.timeout(KICK_TIMEOUT_MS);
		try {
			const message = await session.complete(model, signal ? AbortSignal.any([signal, timeout]) : timeout);
			return message.stopReason === "error"
				? this.finish(session, entry("error", label, { detail: message.errorMessage ?? "the provider returned an error" }), {
						issued: true,
						dedupe: false,
						claimEpoch,
					})
				: this.finish(session, entry("ok", label, { usage: message.usage }), { issued: true, dedupe: false, claimEpoch });
		} catch (error) {
			return this.finish(
				session,
				entry("error", label, {
					detail: signal?.aborted ? "the request was cancelled" : error instanceof Error ? error.message : String(error),
				}),
				{ issued: true, dedupe: false, claimEpoch },
			);
		} finally {
			this.inFlight.delete(provider);
		}
	}

	/** Queue an atomic write of the whole store; writes are serialized and never reject. */
	private save(): void {
		for (const [provider, at] of this.requests) {
			const record = (this.state[provider] ??= { perDay: {} });
			record.lastRequestAt = Math.max(record.lastRequestAt ?? 0, at);
		}
		const today = utcDay(this.now());
		const store: WindowKickStore = {};
		for (const [provider, record] of Object.entries(this.state)) {
			const perDay: Record<string, number> = {};
			for (const [day, count] of Object.entries(record.perDay)) if (day === today) perDay[day] = count;
			store[provider] = { ...record, perDay };
		}
		this.writes = this.writes.then(() => writeStore(this.statePath, store)).catch(() => {});
	}
}
