/**
 * Selection logic for the stable alias model (`localmodel-auto/current`).
 *
 * The alias is a Pi *virtual* model: it never reaches a provider. Its route()
 * picks the physical Strata model registered under the provider id, so the
 * request carries the real Strata id. Keeping the decision here (dependency-
 * free, no Pi types) makes it unit-testable.
 */

/** Anything with a model id — a Pi `Model` or a plain catalog entry. */
export interface AliasCandidate {
	id: string;
}

/** Which id the alias should dispatch to, plus how confident we are. */
export interface AliasSelection {
	id: string;
	/** True when the choice was forced (ambiguous list or unused preference). */
	ambiguous: boolean;
}

/**
 * Choose the dispatch target for the alias.
 *
 * - empty list -> `undefined` (caller reports "Strata is loading or offline").
 * - one model -> that model, unambiguous.
 * - `preferredModel` (substring, case-insensitive) -> the first id containing it.
 * - several models and no usable preference -> deterministic pick (sorted ids)
 *   with `ambiguous: true`, so the caller can warn once. Never fails: an
 *   unusable preference must not make every request throw.
 */
export function selectAliasTarget(
	candidates: readonly AliasCandidate[],
	preferredModel?: string,
): AliasSelection | undefined {
	const ids = candidates
		.map((c) => (typeof c?.id === "string" ? c.id.trim() : ""))
		.filter((id) => id.length > 0);
	if (ids.length === 0) {
		return undefined;
	}
	const preferred = typeof preferredModel === "string" ? preferredModel.trim().toLowerCase() : "";
	if (preferred) {
		const hit = ids.find((id) => id.toLowerCase().includes(preferred));
		if (hit) {
			return { id: hit, ambiguous: false };
		}
	}
	if (ids.length === 1) {
		return { id: ids[0], ambiguous: false };
	}
	const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return { id: sorted[0], ambiguous: true };
}

/**
 * True when the live Strata catalogue no longer matches what is registered,
 * i.e. the Strata model was swapped (or an id disappeared) and the provider
 * registration must be rebuilt.
 *
 * An empty live list means "nothing to compare against" (Strata still loading,
 * or unreachable): never trigger a refresh from it, because the extension keeps
 * the last-known registration and re-registering nothing would wipe the alias's
 * only routing target.
 */
export function catalogMismatch(
	liveIds: readonly string[],
	registeredIds: readonly string[],
): boolean {
	const live = liveIds.map((id) => String(id).trim()).filter((id) => id.length > 0);
	if (live.length === 0) {
		return false;
	}
	const registered = new Set(registeredIds.map((id) => String(id).trim()).filter((id) => id.length > 0));
	if (live.length !== registered.size) {
		return true;
	}
	return !live.every((id) => registered.has(id));
}
