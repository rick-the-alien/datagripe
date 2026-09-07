import type { SchemaInput } from "@datagripe/gripes";
import { type Catalog, catalog } from "./catalog";

/**
 * `SchemaInput` for the client gripe runner, backed by the completion
 * catalog (docs/spec/gripes.md "Where rules run").
 *
 * The contract is that every method may answer `null` for "not known",
 * and a rule that gets `null` stays silent. That is what makes this
 * honest about a lazily-loaded cache: the catalog fetches a table's
 * columns on demand, so the first analysis of a query usually knows
 * nothing. Asking for the columns is the side effect, and when they
 * arrive the store re-analyses and the finding appears — a beat late,
 * but never wrong.
 *
 * `rowsFor` and `indexLeadsWith` always answer `null` because the
 * catalog carries neither. They are declared rather than omitted so a
 * rule needing them compiles and stays quiet, instead of the runner
 * having to know which parts of the schema this particular caller can
 * supply.
 */
export function schemaInputFor(
	connectionId: string,
	instance: Catalog = catalog,
): SchemaInput {
	return {
		rowsFor: () => null,
		indexLeadsWith: () => null,

		isNullable(schemaName, table, column) {
			const found = instance.findTable(
				connectionId,
				table,
				schemaName ?? undefined,
			);
			if (found === undefined) {
				return null;
			}
			const columns = instance.getColumns(
				connectionId,
				found.schema,
				found.table.name,
			);
			if (columns === undefined) {
				// Not "no columns" — not fetched yet. Ask, and let the
				// re-analysis on arrival produce the finding.
				instance.ensureColumns(connectionId, found.schema, found.table.name);
				return null;
			}
			return (
				columns.find((candidate) => candidate.name === column)?.nullable ?? null
			);
		},
	};
}
