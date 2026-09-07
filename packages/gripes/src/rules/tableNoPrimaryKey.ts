import { objectLocation, type Rule } from "../types";

/**
 * `table.no-primary-key` — a base table with no primary key.
 *
 * The table view already refuses to edit one and says why
 * (docs/spec/table-view.md); this is the same fact told where someone
 * is looking at the structure rather than trying to change a row.
 */
export const tableNoPrimaryKey: Rule = {
	id: "table.no-primary-key",
	severity: "warning",
	inputs: ["object"],

	evaluate(context) {
		const object = context.object;
		if (object === undefined || object.kind !== "table") {
			return [];
		}
		// A table with no columns at all has not been described properly;
		// saying it has no key would be a guess.
		if (object.columns.length === 0) {
			return [];
		}
		if (object.columns.some((column) => column.primaryKey)) {
			return [];
		}
		return [
			{
				ruleId: tableNoPrimaryKey.id,
				severity: tableNoPrimaryKey.severity,
				at: objectLocation(object, "columns"),
				facts: { table: object.name },
			},
		];
	},
};
