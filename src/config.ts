/**
 * `<agentDir>/subscription-router.json`: the router profiles.
 *
 * Each profile becomes one virtual model `router/<id>` whose ordered `chain`
 * names physical models. A missing file registers nothing; an invalid one is
 * rejected whole with a message, never partially applied.
 *
 * ```json
 * {
 *   "profiles": {
 *     "default": {
 *       "name": "Router default",
 *       "chain": [
 *         { "model": "anthropic/claude-sonnet-5-5" },
 *         { "model": "openai-codex/gpt-5.6-terra", "thinking": "high" }
 *       ],
 *       "exhaustionPolicy": "wait",
 *       "maxWaitMinutes": 360
 *     }
 *   }
 * }
 * ```
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { parseRef, refKey } from "./model-ref.js";

export const CONFIG_FILE = "subscription-router.json";

/** Provider the virtual models are listed under. */
export const ROUTER_PROVIDER = "router";

export const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** One physical model in a chain. `thinking` pins its level; otherwise the selected level passes through. */
export interface ChainEntry {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

/** What a caller that can wait should do when every quota-eligible entry is exhausted. */
export type ExhaustionPolicy = "fail" | "wait";

export const EXHAUSTION_POLICIES: readonly ExhaustionPolicy[] = ["fail", "wait"];

/** `policy` defaults to "wait"; `maxWaitMs` (unset = no limit) caps how far ahead a reset may be waited for. */
export interface Exhaustion {
	policy: ExhaustionPolicy;
	maxWaitMs?: number;
}

/** Ordered is backwards-compatible; balanced spends reset-aware quota across providers. */
export type Strategy = "ordered" | "balanced";

export interface Profile {
	strategy?: Strategy;
	id: string;
	name: string;
	chain: ChainEntry[];
	/** Only set when the profile configures `exhaustionPolicy` or `maxWaitMinutes`. */
	exhaustion?: Exhaustion;
}

/** Loaded config, or the reason it was rejected. */
export type ConfigResult = { ok: true; profiles: Profile[] } | { ok: false; error: string };

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]*$/;

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function parseEntry(raw: unknown, where: string): ChainEntry {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: expected an object`);
	const { model, thinking } = raw as Record<string, unknown>;
	if (typeof model !== "string") throw new Error(`${where}.model: expected "provider/model-id"`);
	const ref = parseRef(model);
	if (!ref) throw new Error(`${where}.model: expected "provider/model-id"`);
	if (ref.provider === ROUTER_PROVIDER) throw new Error(`${where}.model: a chain cannot name another router model`);
	if (thinking !== undefined && !isThinkingLevel(thinking)) {
		throw new Error(`${where}.thinking: expected one of ${THINKING_LEVELS.join(", ")}`);
	}
	return thinking === undefined ? ref : { ...ref, thinking };
}

function parseExhaustion(policy: unknown, maxWaitMinutes: unknown, where: string): Exhaustion | undefined {
	if (policy === undefined && maxWaitMinutes === undefined) return undefined;
	if (policy !== undefined && !(EXHAUSTION_POLICIES as readonly unknown[]).includes(policy)) {
		throw new Error(`${where}.exhaustionPolicy: expected one of ${EXHAUSTION_POLICIES.join(", ")}`);
	}
	if (maxWaitMinutes !== undefined && (typeof maxWaitMinutes !== "number" || !(maxWaitMinutes > 0))) {
		throw new Error(`${where}.maxWaitMinutes: expected a positive number`);
	}
	return {
		policy: (policy as ExhaustionPolicy | undefined) ?? "wait",
		...(maxWaitMinutes === undefined ? {} : { maxWaitMs: (maxWaitMinutes as number) * 60_000 }),
	};
}

/** Validate a parsed config document. Throws with a path-qualified message. */
export function parseConfig(raw: unknown): Profile[] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected a JSON object");
	const profiles = (raw as Record<string, unknown>).profiles;
	if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
		throw new Error("profiles: expected an object of id -> profile");
	}
	return Object.entries(profiles).map(([id, value]) => {
		const where = `profiles.${id}`;
		if (!PROFILE_ID.test(id)) throw new Error(`${where}: id must match ${PROFILE_ID}`);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: expected an object`);
		const { name, chain, exhaustionPolicy, maxWaitMinutes, strategy } = value as Record<string, unknown>;
		if (strategy !== undefined && strategy !== "ordered" && strategy !== "balanced") {
			throw new Error(`${where}.strategy: expected ordered or balanced`);
		}
		if (name !== undefined && typeof name !== "string") throw new Error(`${where}.name: expected a string`);
		if (!Array.isArray(chain) || chain.length === 0) throw new Error(`${where}.chain: expected a non-empty array`);
		const entries = chain.map((entry, index) => parseEntry(entry, `${where}.chain[${index}]`));
		const seen = new Set<string>();
		for (const entry of entries) {
			const key = refKey(entry);
			if (seen.has(key)) throw new Error(`${where}.chain: ${key} is listed twice`);
			seen.add(key);
		}
		const exhaustion = parseExhaustion(exhaustionPolicy, maxWaitMinutes, where);
		const base: Profile = {
			id,
			name: typeof name === "string" ? name : `Router ${id}`,
			chain: entries,
			...(strategy === undefined ? {} : { strategy }),
		};
		return exhaustion ? { ...base, exhaustion } : base;
	});
}

/** Read `<agentDir>/subscription-router.json`. A missing file is an empty config. */
export async function loadConfig(agentDir: string): Promise<ConfigResult> {
	const path = join(agentDir, CONFIG_FILE);
	let text: string;
	try {
		text = await readFile(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, profiles: [] };
		return { ok: false, error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		return { ok: true, profiles: parseConfig(JSON.parse(text)) };
	} catch (error) {
		return { ok: false, error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
}
