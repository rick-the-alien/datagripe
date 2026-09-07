import { describe, expect, test } from "bun:test";
import type { Catalog, CatalogColumn } from "./catalog";
import { schemaInputFor } from "./schemaInput";

/**
 * The client's `SchemaInput` (docs/spec/gripes.md). What matters here is
 * that "not fetched yet" answers `null` and not `false`: a rule reading
 * `false` would conclude the column is NOT NULL and stay silent about a
 * real problem, or worse, gripe about the wrong thing.
 */

function fakeCatalog(
	columns: Record<string, CatalogColumn[] | undefined>,
	asked: string[] = [],
): Catalog {
	return {
		ensureCatalog: (connectionId) => {
			asked.push(`catalog:${connectionId}`);
		},
		ensureColumns: (_connection, schemaName, tableName) => {
			asked.push(`${schemaName}.${tableName}`);
		},
		getCatalog: () => undefined,
		getColumns: (_connection, schemaName, tableName) =>
			columns[`${schemaName}.${tableName}`],
		findTable: (_connection, tableName) =>
			Object.keys(columns).some((key) => key.endsWith(`.${tableName}`))
				? {
						schema: "public",
						table: { name: tableName, kind: "table" as const },
					}
				: undefined,
		subscribe: () => () => {},
	};
}

describe("isNullable", () => {
	test("answers what the catalog knows", () => {
		const schema = schemaInputFor(
			"conn-1",
			fakeCatalog({
				"public.orders": [
					{ name: "id", nullable: false },
					{ name: "status", nullable: true },
				],
			}),
		);
		expect(schema.isNullable(null, "orders", "status")).toBe(true);
		expect(schema.isNullable(null, "orders", "id")).toBe(false);
	});

	test("null for a table the catalog has never heard of", () => {
		const schema = schemaInputFor("conn-1", fakeCatalog({}));
		expect(schema.isNullable(null, "orders", "status")).toBeNull();
	});

	test("null for a column the table does not have", () => {
		const schema = schemaInputFor(
			"conn-1",
			fakeCatalog({ "public.orders": [{ name: "id", nullable: false }] }),
		);
		expect(schema.isNullable(null, "orders", "status")).toBeNull();
	});

	test("null when the column's nullability was not reported", () => {
		const schema = schemaInputFor(
			"conn-1",
			fakeCatalog({ "public.orders": [{ name: "status" }] }),
		);
		expect(schema.isNullable(null, "orders", "status")).toBeNull();
	});

	test("asks for the catalog, or nothing would ever load", () => {
		// In a project where completion has never run the catalog is empty,
		// so findTable finds nothing and the columns are never requested
		// either. Without this the rule is silent forever, not for a moment.
		const asked: string[] = [];
		const schema = schemaInputFor("conn-1", fakeCatalog({}, asked));
		expect(schema.isNullable(null, "orders", "status")).toBeNull();
		expect(asked).toEqual(["catalog:conn-1"]);
	});

	test("null while the columns are still unfetched, and asks for them", () => {
		// The whole reason a schema rule can be silent on first sight and
		// correct a moment later.
		const asked: string[] = [];
		const schema = schemaInputFor(
			"conn-1",
			fakeCatalog({ "public.orders": undefined }, asked),
		);
		expect(schema.isNullable(null, "orders", "status")).toBeNull();
		expect(asked).toEqual(["catalog:conn-1", "public.orders"]);
	});
});

describe("what the catalog cannot answer", () => {
	test("row counts and index knowledge are always null", () => {
		// Declared rather than omitted, so a rule needing them compiles and
		// stays quiet instead of the runner having to know what this caller
		// can supply.
		const schema = schemaInputFor("conn-1", fakeCatalog({}));
		expect(schema.rowsFor(null, "orders")).toBeNull();
		expect(schema.indexLeadsWith(null, "orders", "status")).toBeNull();
	});
});
