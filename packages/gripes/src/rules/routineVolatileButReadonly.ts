import type { Rule } from "../types";

/**
 * `routine.volatile-but-readonly` — a routine that only reads but is
 * marked `volatile`, which is PostgreSQL's default and therefore what
 * most read-only functions end up saying by accident.
 *
 * The cost is real: the planner cannot inline a volatile function or
 * hoist it out of a per-row context, so it re-runs for every row.
 *
 * Deliberately narrow, because a wrong gripe here would be easy. It
 * fires only on a `LANGUAGE sql` body — a plpgsql body can write
 * through dynamic SQL that no amount of reading the text will reveal —
 * and only when the body contains no write and no dynamic execution at
 * all. Anything less certain stays silent.
 */

const WRITE =
	/\b(insert|update|delete|truncate|merge|copy|nextval|setval|create|drop|alter|grant|revoke)\b/i;
const DYNAMIC = /\bexecute\b/i;
const LANGUAGE_SQL = /\blanguage\s+sql\b/i;
const VOLATILE = /\b(immutable|stable)\b/i;

/**
 * The routine body, without the `CREATE FUNCTION …` header around it.
 *
 * Checking the whole definition for write keywords does not work: every
 * definition begins with `CREATE`, so the rule would find a "write" in
 * every routine and never fire at all. Returns null when the body
 * cannot be located, which keeps the rule silent rather than guessing.
 */
export function routineBody(ddl: string): string | null {
	// pg_get_functiondef emits `AS $tag$ … $tag$`; a hand-written routine
	// may use a plain quoted string instead.
	const dollar = /\bas\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/i.exec(ddl);
	if (dollar !== null) {
		return dollar[2] ?? null;
	}
	const quoted = /\bas\s+'((?:[^']|'')*)'/i.exec(ddl);
	return quoted?.[1] ?? null;
}

export const routineVolatileButReadonly: Rule = {
	id: "routine.volatile-but-readonly",
	severity: "style",
	inputs: ["object"],

	evaluate(context) {
		const object = context.object;
		if (
			object === undefined ||
			(object.kind !== "function" && object.kind !== "procedure") ||
			object.ddl === null
		) {
			return [];
		}
		const ddl = object.ddl;
		// `volatile` is the default, so its absence is what marks a routine
		// volatile — an explicit `immutable` or `stable` means the author
		// already decided.
		if (VOLATILE.test(ddl)) {
			return [];
		}
		if (!LANGUAGE_SQL.test(ddl)) {
			return [];
		}
		const body = routineBody(ddl);
		if (body === null) {
			return [];
		}
		if (WRITE.test(body) || DYNAMIC.test(body)) {
			return [];
		}
		return [
			{
				ruleId: routineVolatileButReadonly.id,
				severity: routineVolatileButReadonly.severity,
				at: {
					kind: "object",
					connectionId: object.connectionId,
					schema: object.schema,
					name: object.name,
					tab: "ddl",
				},
				facts: { routine: object.name },
			},
		];
	},
};
