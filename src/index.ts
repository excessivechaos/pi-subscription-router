/**
 * pi-subscription-router: `router/<profile>` virtual models that route across
 * included subscription quota.
 *
 * Wiring only; the logic lives in `router.ts` (chain routing), `recovery.ts`
 * (mid-run terminal quota errors), `exhaustion.ts` (confirmed blocks) and
 * `usage.ts` (collectors). Usage and exhaustion state are process-global so
 * every session in the process, including in-process subagent children that
 * load their own copy of this module, sees the same confirmed blocks.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type ChainEntry,
	type ConfigResult,
	loadConfig,
	type Profile,
	ROUTER_PROVIDER,
	THINKING_LEVELS,
} from "./config.js";
import { ExhaustionTracker } from "./exhaustion.js";
import { refKey } from "./model-ref.js";
import { SettleRecovery } from "./recovery.js";
import { formatDecision, type RouteDecision, type RouteEnv, Router } from "./router.js";
import { formatScore } from "./selection.js";
import { COLLECTED_PROVIDERS, UsageService } from "./usage.js";

const SHARED_KEY: unique symbol = Symbol.for("pi-subscription-router.shared");
const RPC_ADMIT = "router:rpc:admit";
const RPC_USAGE = "router:rpc:usage";
const PROMPT_SECTION = "subscription_usage";
/** Custom session entry type carrying one `RouteDecision`. */
const DECISION_ENTRY = "router:decision";
/** Decisions kept in memory for `/router status`; the session entries are the full record. */
const RECENT_DECISIONS = 5;

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
		const config = options?.config ?? (await loadConfig(getAgentDir()));
		const profiles = config.ok ? config.profiles : [];
		const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
		let currentCtx: ExtensionContext | undefined;

		/** The router profile behind the current selection, if it is one of ours. */
		const selectedProfile = (ctx: ExtensionContext): Profile | undefined =>
			ctx.model?.provider === ROUTER_PROVIDER ? profileById.get(ctx.model.id) : undefined;

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
			warm(ctx, usage, sessionProviders(ctx, profiles));
		});

		// Cached data only: a slow usage endpoint must not delay the turn. Coarse
		// buckets keep the section stable so the prompt-cache prefix survives.
		pi.on("before_agent_start", (event, ctx) => {
			currentCtx = ctx;
			recovery.resetTurn();
			const providers = sessionProviders(ctx, profiles);
			warm(ctx, usage, providers);
			if (providers.length === 0) return;
			const lines = providers.map((provider) => `- ${provider}: ${usage.formatForPrompt(usage.peek(provider))}`);
			event.systemPromptOptions.sections[PROMPT_SECTION] = [
				...lines,
				"- Treat usage as decision support. Check subscription_usage before subagent fan-out and prefer cheaper models for bounded reconnaissance when capacity is low.",
			].join("\n");
		});

		pi.on("agent_before_settle", async (event, ctx) => {
			const profile = selectedProfile(ctx);
			if (!profile) return undefined;
			const outcome = await recovery.handle(event, profile, routeEnv(ctx, usage), ctx.signal);
			if (outcome.kind === "exhausted") {
				ctx.ui.notify(outcome.error.message, "error");
				return undefined;
			}
			if (outcome.kind !== "continue") return undefined;
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
			description: "Subscription router: status (default), refresh, or reset confirmed blocks",
			handler: async (args, ctx) => {
				const action = args.trim() || "status";
				if (action === "reset") {
					tracker.clear();
					ctx.ui.notify("subscription-router: cleared confirmed blocks", "info");
					return;
				}
				if (action !== "status" && action !== "refresh") {
					ctx.ui.notify(`subscription-router: unknown action "${action}" (status, refresh, reset)`, "error");
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
