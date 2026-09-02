import { describe, expect, test } from "bun:test";
import type { SchemaNode, SchemaPathSegment } from "@datagripe/contracts";
import type { ClientAction } from "@datagripe/contracts/ws";
import { type Catalog, createCatalog } from "./catalog";

const SCHEMAS: SchemaNode[] = [
	{ kind: "schema", name: "public", hasChildren: true },
	{ kind: "schema", name: "app", hasChildren: true },
];
const CATEGORIES: SchemaNode[] = [
	{ kind: "tables", name: "tables", hasChildren: true },
	{ kind: "views", name: "views", hasChildren: true },
];
const COLUMNS: SchemaNode[] = [
	{
		kind: "column",
		name: "id",
		hasChildren: false,
		dataType: "integer",
		nullable: false,
	},
	{
		kind: "column",
		name: "email",
		hasChildren: false,
		dataType: "text",
		nullable: true,
	},
];

/** Records requests and serves canned nodes per path depth. */
function createFakeRequest(options: { failingSchemas?: string[] } = {}) {
	const calls: Array<{ action: ClientAction; path: SchemaPathSegment[] }> = [];
	const request = async <T>(action: ClientAction, payload: unknown) => {
		const { path } = payload as { path: SchemaPathSegment[] };
		calls.push({ action, path });
		const first = path[0];
		if (
			first !== undefined &&
			options.failingSchemas?.includes(first.name) === true
		) {
			throw new Error("schema unavailable");
		}
		if (path.length === 0) {
			return { nodes: SCHEMAS } as T;
		}
		if (path.length === 1) {
			return { nodes: CATEGORIES } as T;
		}
		if (path.length === 2) {
			const category = path[1] as SchemaPathSegment;
			const nodes: SchemaNode[] =
				category.kind === "tables"
					? [
							{ kind: "table", name: "users", hasChildren: true },
							{ kind: "table", name: "orders", hasChildren: true },
						]
					: [{ kind: "view", name: "user_stats", hasChildren: true }];
			return { nodes } as T;
		}
		return { nodes: COLUMNS } as T;
	};
	return { calls, request };
}

const CONN = "conn-1";

/** Resolves once the connection's catalog leaves the loading state. */
function awaitCatalog(cat: Catalog, connectionId: string): Promise<void> {
	if (cat.getCatalog(connectionId)?.status !== "loading") {
		return Promise.resolve();
	}
	return (() => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = cat.subscribe((updated) => {
			if (
				updated === connectionId &&
				cat.getCatalog(connectionId)?.status !== "loading"
			) {
				unsubscribe();
				resolve();
			}
		});
		return promise;
	})();
}

/** Resolves once a table's columns are cached. */
function awaitColumns(
	cat: Catalog,
	connectionId: string,
	schema: string,
	table: string,
): Promise<void> {
	if (cat.getColumns(connectionId, schema, table) !== undefined) {
		return Promise.resolve();
	}
	return (() => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = cat.subscribe((updated) => {
			if (
				updated === connectionId &&
				cat.getColumns(connectionId, schema, table) !== undefined
			) {
				unsubscribe();
				resolve();
			}
		});
		return promise;
	})();
}

describe("schema catalog", () => {
	test("loads schemas plus table/view lists, but never columns up front", async () => {
		const fake = createFakeRequest();
		const cat = createCatalog(fake.request);
		cat.ensureCatalog(CONN);
		await awaitCatalog(cat, CONN);

		const entry = cat.getCatalog(CONN);
		expect(entry?.status).toBe("ready");
		expect([...(entry?.schemas.keys() ?? [])]).toEqual(["public", "app"]);
		expect([...(entry?.schemas.get("public")?.tables.keys() ?? [])]).toEqual([
			"users",
			"orders",
			"user_stats",
		]);
		expect(entry?.schemas.get("app")?.tables.get("user_stats")?.kind).toBe(
			"view",
		);
		// Column-level requests (depth 3) only happen via ensureColumns.
		expect(fake.calls.some((call) => call.path.length > 2)).toBe(false);

		// Cached: a second ensure issues no new requests.
		const count = fake.calls.length;
		cat.ensureCatalog(CONN);
		expect(fake.calls).toHaveLength(count);
	});

	test("ensureColumns fetches lazily, caches, and dedupes in-flight", async () => {
		const fake = createFakeRequest();
		const cat = createCatalog(fake.request);
		cat.ensureCatalog(CONN);
		await awaitCatalog(cat, CONN);
		const countAfterCatalog = fake.calls.length;

		// Two synchronous calls share one in-flight request.
		cat.ensureColumns(CONN, "public", "users");
		cat.ensureColumns(CONN, "public", "users");
		await awaitColumns(cat, CONN, "public", "users");

		const columnCalls = fake.calls
			.slice(countAfterCatalog)
			.filter((call) => call.path.length === 3);
		expect(columnCalls).toHaveLength(1);
		expect(columnCalls[0]?.path).toEqual([
			{ kind: "schema", name: "public" },
			{ kind: "tables", name: "tables" },
			{ kind: "table", name: "users" },
		]);
		expect(cat.getColumns(CONN, "public", "users")).toEqual([
			{ name: "id", dataType: "integer", nullable: false },
			{ name: "email", dataType: "text", nullable: true },
		]);

		// Cached columns issue no further requests.
		cat.ensureColumns(CONN, "public", "users");
		expect(fake.calls.filter((call) => call.path.length === 3)).toHaveLength(1);
	});

	test("a failing schema is skipped without poisoning the others", async () => {
		const fake = createFakeRequest({ failingSchemas: ["app"] });
		const cat = createCatalog(fake.request);
		cat.ensureCatalog(CONN);
		await awaitCatalog(cat, CONN);

		const entry = cat.getCatalog(CONN);
		expect(entry?.status).toBe("ready");
		expect(entry?.schemas.get("public")?.tables.size).toBe(3);
		expect(entry?.schemas.get("app")?.tables.size).toBe(0);
		expect(cat.findTable(CONN, "users")).toEqual({
			schema: "public",
			table: { name: "users", kind: "table", columns: undefined },
		});
	});

	test("a failing root load lands as error and can be retried", async () => {
		const calls: SchemaPathSegment[][] = [];
		let failures = 1;
		const request = async <T>(_action: ClientAction, payload: unknown) => {
			const { path } = payload as { path: SchemaPathSegment[] };
			calls.push(path);
			if (failures > 0) {
				failures -= 1;
				throw new Error("connection down");
			}
			return { nodes: path.length === 0 ? SCHEMAS : CATEGORIES } as T;
		};
		const cat = createCatalog(request);
		cat.ensureCatalog(CONN);
		await awaitCatalog(cat, CONN);
		expect(cat.getCatalog(CONN)?.status).toBe("error");

		cat.ensureCatalog(CONN);
		expect(calls.length).toBeGreaterThan(1);
	});
});
