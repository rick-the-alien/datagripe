import type { SqlDialect } from "@datagripe/sql-tools";
import { statementInputFor } from "../statement";
import type { ObjectInput, Rule } from "../types";

/** Fixture builders for rule tests. Not exported from the package. */

export function statementFor(sql: string, dialect: SqlDialect = "postgres") {
	return statementInputFor({ documentId: "doc-1", dialect, text: sql });
}

export function findingsFor(
	rule: Rule,
	sql: string,
	dialect: SqlDialect = "postgres",
) {
	return rule.evaluate({ statement: statementFor(sql, dialect) });
}

export function objectFor(overrides: Partial<ObjectInput> = {}): ObjectInput {
	return {
		connectionId: "conn-1",
		schema: "shop",
		name: "orders",
		kind: "table",
		columns: [{ name: "id", primaryKey: true, nullable: false }],
		indexes: [],
		rowEstimate: 10,
		ddl: null,
		...overrides,
	};
}

export function objectFindingsFor(
	rule: Rule,
	overrides: Partial<ObjectInput> = {},
) {
	return rule.evaluate({ object: objectFor(overrides) });
}
