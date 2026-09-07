import { objectLocation, type Rule } from "../types";

/**
 * `routine.definer-no-search-path` — `SECURITY DEFINER` with no
 * `search_path` pinned.
 *
 * The real one on this list. A definer routine runs with the owner's
 * privileges but resolves unqualified names using the *caller's*
 * `search_path`, so anyone who can create a schema can shadow a table
 * or function the body calls and have it run as the owner. Pinning
 * `search_path` on the routine closes it.
 *
 * A blocker, and the only rule here that is about a vulnerability
 * rather than a cost.
 */

const DEFINER = /\bsecurity\s+definer\b/i;
/** `SET search_path` on the routine, in any of its spellings. */
const PINNED = /\bset\s+search_path\b/i;

export const routineDefinerNoSearchPath: Rule = {
	id: "routine.definer-no-search-path",
	severity: "blocker",
	inputs: ["object"],

	evaluate(context) {
		const object = context.object;
		if (
			object === undefined ||
			(object.kind !== "function" && object.kind !== "procedure")
		) {
			return [];
		}
		// Without the definition there is nothing to read, and guessing
		// that a routine is unsafe would be the worst kind of wrong gripe.
		if (object.ddl === null) {
			return [];
		}
		if (!DEFINER.test(object.ddl) || PINNED.test(object.ddl)) {
			return [];
		}
		return [
			{
				ruleId: routineDefinerNoSearchPath.id,
				severity: routineDefinerNoSearchPath.severity,
				at: objectLocation(object, "ddl"),
				facts: { routine: object.name },
			},
		];
	},
};
