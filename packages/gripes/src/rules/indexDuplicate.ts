import type { Finding } from "@datagripe/contracts";
import type { Rule } from "../types";

/**
 * `index.duplicate` — an index whose key columns are a leading prefix of
 * another index's. The narrower one is already served by the wider one,
 * so it costs every write and buys no read.
 *
 * Prefix, not equality: a btree on `(a)` is fully covered by one on
 * `(a, b)`, which is the case people actually accumulate.
 */

/** Key columns, split and trimmed. Sort direction is part of the key. */
function keyColumns(columns: string): string[] {
	return columns
		.split(",")
		.map((column) => column.trim().toLowerCase())
		.filter((column) => column !== "");
}

function isPrefixOf(shorter: string[], longer: string[]): boolean {
	if (shorter.length === 0 || shorter.length >= longer.length) {
		return false;
	}
	return shorter.every((column, index) => column === longer[index]);
}

export const indexDuplicate: Rule = {
	id: "index.duplicate",
	severity: "style",
	inputs: ["object"],

	evaluate(context) {
		const object = context.object;
		if (object === undefined) {
			return [];
		}
		const indexes = object.indexes.map((index) => ({
			...index,
			keys: keyColumns(index.columns),
		}));
		const findings: Finding[] = [];
		for (const candidate of indexes) {
			// A unique index is not redundant even when its columns are a
			// prefix: it enforces a constraint the wider index does not.
			if (candidate.unique || candidate.keys.length === 0) {
				continue;
			}
			const covering = indexes.find(
				(other) =>
					other.name !== candidate.name &&
					isPrefixOf(candidate.keys, other.keys),
			);
			if (covering === undefined) {
				continue;
			}
			findings.push({
				ruleId: indexDuplicate.id,
				severity: indexDuplicate.severity,
				at: {
					kind: "object",
					connectionId: object.connectionId,
					schema: object.schema,
					name: object.name,
					tab: "indexes",
				},
				facts: { index: candidate.name, covering: covering.name },
			});
		}
		return findings;
	},
};
