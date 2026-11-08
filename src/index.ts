/**
 * pi-subscription-router: `router/<profile>` virtual models that route across
 * included subscription quota.
 *
 * Wiring only; the logic lives in `router.ts` (chain routing), `recovery.ts`
 * (mid-run terminal quota errors), `exhaustion.ts` (confirmed blocks),
 * `kick.ts` (quota-window kicks) and `usage.ts` (collectors). Usage and
 * exhaustion state are process-global so
 * every session in the process, including in-process subagent children that
 * load their own copy of this module, sees the same confirmed blocks.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Api, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { Type } from "typebox";
import {
	type ChainEntry,
	type ConfigResult,
	DEFAULT_WINDOW_KICK,
	loadConfig,
	type Profile,
	ROUTER_PROVIDER,
	THINKING_LEVELS,
} from "./config.js";
import { ExhaustionTracker } from "./exhaustion.js";
import { KICK_ENTRY, KICK_FILE, type KickSession, kickContext, kickModel, kickOptions, WindowKick } from "./kick.js";
import { refKey } from "./model-ref.js";
import { SettleRecovery } from "./recovery.js";
import { formatDecision, type RouteDecision, type RouteEnv, Router } from "./router.js";
import { formatScore } from "./selection.js";
import { COLLECTED_PROVIDERS, UsageService } from "./usage.js";

const SHARED_KEY: unique symbol = Symbol.for("pi-subscription-router.shared");
const RPC_ADMIT = "router:rpc:admit";
const RPC_USAGE = "router:rpc:usage";
/** Custom session entry type carrying one `RouteDecision`. */
const DECISION_ENTRY = "router:decision";
/** Decisions kept in memory for `/router status`; the session entries are the full record. */
const RECENT_DECISIONS = 5;
/** Poll interval for quota-window kicks; the usage cache still limits network reads to one per five minutes. */
/** Session entry naming the model the next request will use, for extensions that act before it. */
export const NEXT_ENTRY = "router:next";
/**
 * Live accessor on `globalThis`: `(ctx) => "provider/id" | undefined`, the model the router would use
 * for the next request of the context's selected profile. Unlike the entry it has no ordering
 * dependency on handlers, and it always reflects current quota marks.
 */
export const PEEK_NEXT = Symbol.for("pi-subscription-router:peek-next");
const KICK_POLL_MS = 60_000;

/** The usage cache surface consumed by the extension, including routing decisions. */
export type RouterUsage = Pick<UsageService, "get" | "peek" | "decisionFor" | "format" | "formatForPrompt">;

/** Explicit dependencies isolate embedded sessions from process-global quota and credentials. */
export interface SubscriptionRouterOptions {
	config: ConfigResult;
	usage: RouterUsage;
	tracker?: ExhaustionTracker;
	now?: () => number;
}

interface Shared {
	usage: RouterUsage;
	tracker: ExhaustionTracker;
	/** One kicker per process: sessions and in-process children share it, so an epoch is kicked once. */
	kick?: WindowKick;
}

function shared(): Shared {
	const host = globalThis as typeof globalThis & { [SHARED_KEY]?: Shared };
	host[SHARED_KEY] ??= { usage: new UsageService(), tracker: new ExhaustionTracker() };
	return host[SHARED_KEY];
}

/** `RouteEnv` backed by the live model registry and the shared usage cache. */
function routeEnv(ctx: ExtensionContext, usage: RouterUsage): RouteEnv {
	return {
		resolve: (entry: ChainEntry) => {
			const model = ctx.modelRegistry.find(entry.provider, entry.id);
			return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
		},
		refresh: async (model, signal, notBefore) => {
			const snapshot = await usage.get(ctx, model.provider, { fresh: true, notBefore, signal });
			return snapshot.status === "available" && snapshot.retrievedAt >= notBefore
				? usage.decisionFor(model, snapshot)
				: undefined;
		},
	};
}

/** Collected providers relevant to this session: chains, scoped models and the selection. */
function sessionProviders(ctx: ExtensionContext, profiles: readonly Profile[]): string[] {
	const providers = new Set<string>(profiles.flatMap((profile) => profile.chain.map((entry) => entry.provider)));
	for (const { model } of ctx.scopedModels) providers.add(model.provider);
	if (ctx.model) providers.add(ctx.model.provider);
	return [...providers].filter((provider) => COLLECTED_PROVIDERS.includes(provider));
}

/** Warm cold usage caches in the background; never awaited on the hot path. */
function warm(ctx: ExtensionContext, usage: RouterUsage, providers: readonly string[]): void {
	for (const provider of providers) {
		if (usage.peek(provider)?.status !== "available") void usage.get(ctx, provider);
	}
}

/** Reply on `${channel}:reply:${requestId}` with the pi-subagents RPC envelope. */
function handleRpc(
	pi: ExtensionAPI,
	channel: string,
	fn: (params: Record<string, unknown>) => unknown | Promise<unknown>,
): void {
	pi.events.on(channel, async (raw) => {
		const params = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
		if (!requestId) return;
		try {
			pi.events.emit(`${channel}:reply:${requestId}`, { success: true, data: await fn(params) });
		} catch (error) {
			pi.events.emit(`${channel}:reply:${requestId}`, {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

/** Create an isolated router when dependencies are explicit; otherwise share state across real children. */
export function createSubscriptionRouter(options?: SubscriptionRouterOptions): ExtensionFactory {
	return async (pi: ExtensionAPI): Promise<void> => {
		const now = options?.now ?? Date.now;
		const { usage, tracker } = options
			? { usage: options.usage, tracker: options.tracker ?? new ExhaustionTracker(now) }
			: shared();
		const recent: RouteDecision[] = [];
		const persisted = new Map<string, string>();
		const record = (decision: RouteDecision): void => {
			recent.push(decision);
			if (recent.length > RECENT_DECISIONS) recent.shift();
			// Session entries are never pruned. Persisting only a profile's first decision per session
			// and each change of chosen model slows growth; it is not a bound (flapping appends).
			if (persisted.get(decision.profile) === decision.chosen) return;
			persisted.set(decision.profile, decision.chosen);
			// Logging must never fail a route.
			try {
				pi.appendEntry(DECISION_ENTRY, decision);
			} catch {}
		};
		const router = new Router(usage, tracker, now, record);
		const recovery = new SettleRecovery(router);
		const agentDir = getAgentDir();
		const config = options?.config ?? (await loadConfig(agentDir));
		const profiles = config.ok ? config.profiles : [];
		const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
		const kickConfig = config.ok ? config.windowKick : DEFAULT_WINDOW_KICK;
		const processState = options ? undefined : shared();
		const kick =
			processState?.kick ?? new WindowKick({ config: kickConfig, statePath: join(agentDir, KICK_FILE), now });
		if (processState) processState.kick = kick;
		/** Providers the kick covers that also have a usage collector. */
		const kickProviders = kickConfig.enabled
			? Object.keys(kickConfig.providers).filter((provider) => COLLECTED_PROVIDERS.includes(provider))
			: [];
		let currentCtx: ExtensionContext | undefined;

		/** The router profile behind the current selection, if it is one of ours. */
		const selectedProfile = (ctx: ExtensionContext): Profile | undefined =>
			ctx.model?.provider === ROUTER_PROVIDER ? profileById.get(ctx.model.id) : undefined;

		/** Host operations for one kick, bound to the context that triggered it. */
		const kickSession = (ctx: ExtensionContext): KickSession => ({
			resolve: (provider) => kickModel(ctx.modelRegistry, provider, kickConfig),
			complete: (model, signal) =>
				ctx.modelRegistry.complete(
					model,
					kickContext(now()),
					// The reasoning switch is provider-native and absent from `StreamOptions`.
					kickOptions(model, signal) as ModelsApiStreamOptions<Api>,
				),
			record: (entry) => {
				try {
					pi.appendEntry(KICK_ENTRY, entry);
				} catch {}
			},
		});

		/** Poll usage and kick a provider whose 5-hour reset instant has passed. Never rejects. */
		const pumpKicks = async (ctx: ExtensionContext): Promise<void> => {
			const session = kickSession(ctx);
			await Promise.all(
				kickProviders.map(async (provider) => {
					try {
						await kick.observe(await usage.get(ctx, provider), session, ctx.signal);
					} catch {}
				}),
			);
		};

		let kickTimer: ReturnType<typeof setInterval> | undefined;
		const startKickTimer = (): void => {
			if (kickTimer || kickProviders.length === 0) return;
			kickTimer = setInterval(() => {
				const ctx = currentCtx;
				if (ctx) void pumpKicks(ctx);
			}, KICK_POLL_MS);
			// A polling timer must never keep a non-interactive run alive.
			kickTimer.unref?.();
		};

		for (const profile of profiles) {
			pi.registerVirtualModel({
				provider: ROUTER_PROVIDER,
				id: profile.id,
				name: profile.name,
				thinkingLevels: THINKING_LEVELS,
				route: (request, ctx) => router.route(profile, request, routeEnv(ctx, usage)),
			});
		}

		pi.on("session_start", (_event, ctx) => {
			currentCtx = ctx;
			// A new or resumed session has no durable decision yet; its first pick must persist.
			persisted.clear();
			if (!config.ok) ctx.ui.notify(`subscription-router: ignoring config. ${config.error}`, "error");
			if (config.ok && config.windowKickError !== undefined) {
				// The kick block fell back to its defaults; say so once, without failing the session.
				try {
					pi.appendEntry("router", { kind: "window-kick-config", reason: config.windowKickError });
				} catch {}
			}
			warm(ctx, usage, sessionProviders(ctx, profiles));
			void pumpKicks(ctx);
			startKickTimer();
		});

		pi.on("session_shutdown", () => {
			if (kickTimer) clearInterval(kickTimer);
			kickTimer = undefined;
		});

		// A real request starts the window by itself, so it cancels a pending kick.
		pi.on("provider_stream_event", (event) => {
			kick.noteRequest(event.provider);
		});

		// Cached data only: a slow usage endpoint must not delay the turn. Coarse
		// buckets keep the section stable so the prompt-cache prefix survives.
		// Quota is the router's business, not the model's: publishing it into the system
		// prompt made the head change whenever a bucket flipped, and every head change
		// re-bills the whole cached prefix.
		pi.on("before_agent_start", (_event, ctx) => {
			currentCtx = ctx;
			recovery.resetTurn();
			warm(ctx, usage, sessionProviders(ctx, profiles));
			void pumpKicks(ctx);
		});

		(globalThis as Record<symbol, unknown>)[PEEK_NEXT] = (ctx: ExtensionContext): string | undefined => {
			try {
				const profile = selectedProfile(ctx);
				if (!profile) return undefined;
				const picked = router.pick(profile, routeEnv(ctx, usage));
				return picked.ok ? refKey(picked.entry) : undefined;
			} catch {
				return undefined;
			}
		};
		/**
		 * Tell other extensions which model the next request will use. Only the router can: the pick
		 * depends on live quota state that is not persisted anywhere. `turn_end` is the earliest point
		 * where a request is about to follow, and it precedes any settle-time handler, so a consumer at
		 * `agent_before_settle` never depends on handler order.
		 */
		const publishNext = (ctx: ExtensionContext, source: "turn_end" | "recovery", model?: string): void => {
			try {
				const profile = selectedProfile(ctx);
				if (!profile) return;
				let key = model;
				if (key === undefined) {
					const picked = router.pick(profile, routeEnv(ctx, usage));
					if (!picked.ok) return;
					key = refKey(picked.entry);
				}
				pi.appendEntry(NEXT_ENTRY, { model: key, source, at: now() });
			} catch {}
		};
		pi.on("turn_end", (_event, ctx) => publishNext(ctx, "turn_end"));

		pi.on("agent_before_settle", async (event, ctx) => {
			const profile = selectedProfile(ctx);
			if (!profile) return undefined;
			const outcome = await recovery.handle(event, profile, routeEnv(ctx, usage), ctx.signal);
			if (outcome.kind === "exhausted") {
				ctx.ui.notify(outcome.error.message, "error");
				return undefined;
			}
			if (outcome.kind !== "continue") return undefined;
			publishNext(ctx, "recovery", outcome.to);
			ctx.ui.notify(`subscription-router: ${outcome.from} is out of quota, continuing on ${outcome.to}`, "warning");
			return outcome.result;
		});

		pi.registerTool({
			name: "subscription_usage",
			label: "Subscription Usage",
			description:
				"Inspect subscription quota windows and the router's confirmed exhaustion blocks. Exhausted families are skipped by router/* models until they reset.",
			promptSnippet: "Inspect subscription quota before expensive subagent fan-out",
			parameters: Type.Object({
				provider: Type.Optional(Type.String({ description: "Provider to inspect. Omit for every relevant provider." })),
				refresh: Type.Optional(Type.Boolean({ description: "Request a live refresh. Limited to once per minute." })),
			}),
			async execute(_id, params, signal, _update, ctx) {
				const providers = params.provider ? [params.provider] : sessionProviders(ctx, profiles);
				const snapshots = await Promise.all(
					providers.map((provider) => usage.get(ctx, provider, { force: params.refresh, signal })),
				);
				const lines = snapshots.map((snapshot) => `${snapshot.provider}: ${usage.format(snapshot)}`);
				for (const mark of tracker.active()) {
					const scope = mark.families ? `${mark.provider} ${mark.families.join(",")}` : mark.provider;
					lines.push(`blocked ${scope}: ${mark.window} until ${new Date(mark.until).toISOString()}`);
				}
				return {
					content: [{ type: "text", text: lines.join("\n") || "No subscription providers in use." }],
					details: { snapshots, blocks: tracker.active() },
				};
			},
		});

		pi.registerCommand("router", {
			description: "Subscription router: status (default), refresh, kick <provider>, or reset confirmed blocks",
			handler: async (args, ctx) => {
				const words = args.trim().split(/\s+/).filter(Boolean);
				const action = words[0] ?? "status";
				if (action === "reset") {
					tracker.clear();
					ctx.ui.notify("subscription-router: cleared confirmed blocks", "info");
					return;
				}
				if (action === "kick") {
					const provider = words[1];
					if (!provider) {
						ctx.ui.notify("subscription-router: /router kick needs a provider", "error");
						return;
					}
					const entry = await kick.manual(provider, kickSession(ctx), ctx.signal);
					const cost = entry.usage ? ` ${entry.usage.input} in / ${entry.usage.output} out, $${entry.usage.cost.total}` : "";
					const detail = entry.detail ? ` (${entry.detail})` : "";
					ctx.ui.notify(
						`subscription-router: window kick ${provider} -> ${entry.model || "no model"} ${entry.outcome}${cost}${detail}`,
						entry.outcome === "ok" ? "info" : "warning",
					);
					return;
				}
				if (action !== "status" && action !== "refresh") {
					ctx.ui.notify(`subscription-router: unknown action "${action}" (status, refresh, kick, reset)`, "error");
					return;
				}
				const providers = sessionProviders(ctx, profiles);
				const snapshots =
					action === "refresh"
						? await Promise.all(providers.map((provider) => usage.get(ctx, provider, { force: true })))
						: providers.flatMap((provider) => {
								const snapshot = usage.peek(provider);
								return snapshot ? [snapshot] : [];
							});
				const env = routeEnv(ctx, usage);
				const lines = snapshots.map((snapshot) => `${snapshot.provider}: ${usage.format(snapshot)}`);
				for (const profile of profiles) {
					const picked = router.pick(profile, env);
					lines.push(
						`router/${profile.id} (${profile.strategy ?? "ordered"}) -> ${picked.ok ? refKey(picked.entry) : "exhausted"}`,
					);
					if (picked.ok) {
						for (const candidate of picked.candidates)
							lines.push(`  ${refKey(candidate.entry)}: ${formatScore(candidate.score)}`);
					}
					for (const block of picked.blocked) lines.push(`  ${refKey(block.entry)}: ${block.reason}`);
				}
				lines.push(`window kick: ${await kick.describe()}`);
				if (recent.length > 0) {
					lines.push("last decisions (newest last):", ...recent.map(formatDecision));
				}
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});

		// `{ model: "provider/id" }` -> `Admission`. Before the first session_start
		// there is no context to read usage through, so everything is admitted.
		handleRpc(pi, RPC_ADMIT, (params) => {
			const ctx = currentCtx;
			const ref = typeof params.model === "string" ? params.model : "";
			return ctx ? router.admit(ref, profileById, routeEnv(ctx, usage)) : { ok: true };
		});

		handleRpc(pi, RPC_USAGE, async (params) => {
			const ctx = currentCtx;
			if (params.refresh === true && ctx) {
				await Promise.all(COLLECTED_PROVIDERS.map((provider) => usage.get(ctx, provider)));
			}
			return {
				snapshots: COLLECTED_PROVIDERS.flatMap((provider) => {
					const snapshot = usage.peek(provider);
					return snapshot ? [snapshot] : [];
				}),
				blocks: tracker.active(),
			};
		});
	};
}

export default createSubscriptionRouter();
