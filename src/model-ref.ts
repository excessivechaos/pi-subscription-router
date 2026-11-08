/** `provider/id` model identity, shared by config, routing, recovery and admission. */

/** A model's identity, independent of its registry entry. */
export interface ModelRef {
	provider: string;
	id: string;
}

/** `"provider/id"`. */
export function refKey(model: ModelRef): string {
	return `${model.provider}/${model.id}`;
}

/** Split `"provider/id"`; undefined when either side is empty. The id may contain `/`. */
export function parseRef(ref: string): ModelRef | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** Whether two refs name the same model. */
export function sameModel(a: ModelRef, b: ModelRef): boolean {
	return a.provider === b.provider && a.id === b.id;
}
