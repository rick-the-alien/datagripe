import type { SqlDialect } from "@datagripe/sql-tools";
import { statementInputFor } from "../statement";
import type { AccessInput, ObjectInput, Rule, SchemaInput } from "../types";

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

/**
 * A schema that knows exactly what it is told and answers `null` for
 * everything else — which is what a rule must handle by staying silent.
 */
export function schemaFor(
	known: {
		nullable?: Record<string, boolean>;
		rows?: Record<string, number>;
		indexed?: Record<string, boolean>;
	} = {},
): SchemaInput {
	const key = (schema: string | null, table: string, column?: string) =>
		[schema ?? "", table, column ?? ""].join(".");
	return {
		rowsFor: (schema, table) => known.rows?.[key(schema, table)] ?? null,
		indexLeadsWith: (schema, table, column) =>
			known.indexed?.[key(schema, table, column)] ?? null,
		isNullable: (schema, table, column) =>
			known.nullable?.[key(schema, table, column)] ?? null,
	};
}

export function schemaFindingsFor(
	rule: Rule,
	sql: string,
	schema: SchemaInput,
	dialect: SqlDialect = "postgres",
) {
	return rule.evaluate({ statement: statementFor(sql, dialect), schema });
}

/**
 * A resolved-access fixture. The default is deliberately harmless: an
 * owner-only table with one untrusted role that reaches nothing, so a
 * rule that fires on this default is firing on no evidence.
 */
export function accessFor(overrides: Partial<AccessInput> = {}): AccessInput {
	return {
		connectionId: "conn-1",
		schema: "api",
		name: "orders",
		kind: "table",
		owner: "api_owner",
		rls: "forced",
		policyCount: 2,
		securityInvoker: null,
		securityDefiner: null,
		searchPathPinned: null,
		reach: [{ role: "anon", untrusted: true, privileges: [], blocked: false }],
		viewBypass: null,
		defaultAclUntrusted: [],
		...overrides,
	};
}

export function accessFindingsFor(
	rule: Rule,
	overrides: Partial<AccessInput> = {},
) {
	return rule.evaluate({ access: accessFor(overrides) });
}
