/**
 * Confirmed quota exhaustion, per `(provider, family)`.
 *
 * A mark is only ever written after a fresh usage read confirmed the block
 * (see `Router.confirm`), so a transient 429 never removes a model from its
 * chain. A mark with a known reset lasts until that reset. Without one it
 * backs off exponentially, 5 minutes doubling up to 60, keyed on how often the
 * same scope was re-confirmed.
 */

import { modelMatchesFamily, type UsageDecision } from "./usage.js";

const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;

/** One confirmed block. `families` undefined means the whole provider. */
export interface ExhaustionMark {
	provider: string;
	families?: string[];
	window: string;
	until: number;
	/** Whether `until` came from the provider rather than the backoff. */
	resetKnown: boolean;
	confirmations: number;
}

import type { ModelRef } from "./model-ref.js";

function scopeKey(provider: string, families: readonly string[] | undefined): string {
	return families?.length ? `${provider}:${[...families].sort().join(",")}` : `${provider}:*`;
}

/** Tracks confirmed exhaustion so routing can skip blocked families without a network read. */
export class ExhaustionTracker {
	private readonly marks = new Map<string, ExhaustionMark>();

	constructor(private readonly now: () => number = Date.now) {}

	/** Record a confirmed block for the scope of `decision` and return the mark. */
	mark(model: ModelRef, decision: UsageDecision): ExhaustionMark {
		const families = decision.scope === "model" ? decision.families : undefined;
		const key = scopeKey(model.provider, families);
		const now = this.now();
		const previous = this.marks.get(key);
		// A block that lifted more than a full backoff cycle ago is a new episode.
		const recent = previous !== undefined && now - previous.until < BACKOFF_CAP_MS;
		const confirmations = (recent ? previous.confirmations : 0) + 1;
		const resetKnown = decision.resetAt !== undefined && decision.resetAt > now;
		const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (confirmations - 1), BACKOFF_CAP_MS);
		const mark: ExhaustionMark = {
			provider: model.provider,
			families,
			window: decision.window ?? "included quota",
			until: resetKnown && decision.resetAt !== undefined ? decision.resetAt : now + backoff,
			resetKnown,
			confirmations,
		};
		this.marks.set(key, mark);
		return mark;
	}

	/** The live mark covering `model`, if any. Expired marks are kept so a quick re-confirmation grows the backoff. */
	blocking(model: ModelRef): ExhaustionMark | undefined {
		const now = this.now();
		for (const mark of this.marks.values()) {
			if (mark.until <= now || mark.provider !== model.provider) continue;
			if (!mark.families || mark.families.some((family) => modelMatchesFamily(model.id, family))) return mark;
		}
		return undefined;
	}

	/** Live marks, for status output. */
	active(): ExhaustionMark[] {
		const now = this.now();
		return [...this.marks.values()].filter((mark) => mark.until > now);
	}

	/** Forget every mark, e.g. from `/router reset`. */
	clear(): void {
		this.marks.clear();
	}
}
