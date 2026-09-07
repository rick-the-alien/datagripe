import { describe, expect, test } from "bun:test";
import { objectFindingsFor } from "./fixtures";
import { indexDuplicate } from "./indexDuplicate";
import { routineDefinerNoSearchPath } from "./routineDefinerNoSearchPath";
import { routineVolatileButReadonly } from "./routineVolatileButReadonly";
import { tableNoPrimaryKey } from "./tableNoPrimaryKey";

/** The object-input rules (docs/spec/gripes.md). */

describe("table.no-primary-key", () => {
	test("fires on a table with no key column", () => {
		const found = objectFindingsFor(tableNoPrimaryKey, {
			columns: [
				{ name: "label", primaryKey: false, nullable: true },
				{ name: "qty", primaryKey: false, nullable: true },
			],
		});
		expect(found).toHaveLength(1);
		expect(found[0]?.facts).toEqual({ table: "orders" });
		// It annotates the columns tab, which is where the absence shows.
		if (found[0]?.at.kind === "object") {
			expect(found[0].at.tab).toBe("columns");
		}
	});

	test("does not fire when a key exists", () => {
		expect(objectFindingsFor(tableNoPrimaryKey, {})).toEqual([]);
	});

	test("does not fire on a view, which cannot have one", () => {
		expect(
			objectFindingsFor(tableNoPrimaryKey, {
				kind: "view",
				columns: [{ name: "label", primaryKey: false, nullable: true }],
			}),
		).toEqual([]);
	});

	test("stays silent when the columns are unknown", () => {
		// No columns means the object was not described, not that it has no
		// key. Guessing here would be a wrong gripe.
		expect(objectFindingsFor(tableNoPrimaryKey, { columns: [] })).toEqual([]);
	});
});

describe("index.duplicate", () => {
	test("fires when one index is a prefix of another", () => {
		const found = objectFindingsFor(indexDuplicate, {
			indexes: [
				{ name: "idx_a", columns: "user_id", unique: false },
				{ name: "idx_ab", columns: "user_id, created_at", unique: false },
			],
		});
		expect(found).toHaveLength(1);
		expect(found[0]?.facts).toEqual({ index: "idx_a", covering: "idx_ab" });
	});

	test("does not fire on unrelated indexes", () => {
		expect(
			objectFindingsFor(indexDuplicate, {
				indexes: [
					{ name: "idx_a", columns: "user_id", unique: false },
					{ name: "idx_b", columns: "created_at", unique: false },
				],
			}),
		).toEqual([]);
	});

	test("does not fire when the columns differ in order", () => {
		// `(b, a)` is not served by `(a, b)`: a btree prefix is ordered.
		expect(
			objectFindingsFor(indexDuplicate, {
				indexes: [
					{ name: "idx_ba", columns: "created_at, user_id", unique: false },
					{ name: "idx_ab", columns: "user_id, created_at", unique: false },
				],
			}),
		).toEqual([]);
	});

	test("a unique index is never redundant", () => {
		// It enforces a constraint the wider index does not, so dropping it
		// would change behaviour rather than just save writes.
		expect(
			objectFindingsFor(indexDuplicate, {
				indexes: [
					{ name: "uq_a", columns: "user_id", unique: true },
					{ name: "idx_ab", columns: "user_id, created_at", unique: false },
				],
			}),
		).toEqual([]);
	});

	test("identical column lists are not a prefix of each other", () => {
		// Two indexes on exactly the same columns are a different finding,
		// and claiming one is a prefix of the other would name them
		// arbitrarily.
		expect(
			objectFindingsFor(indexDuplicate, {
				indexes: [
					{ name: "idx_one", columns: "user_id", unique: false },
					{ name: "idx_two", columns: "user_id", unique: false },
				],
			}),
		).toEqual([]);
	});

	test("sort direction is part of the key", () => {
		expect(
			objectFindingsFor(indexDuplicate, {
				indexes: [
					{ name: "idx_desc", columns: "created_at DESC", unique: false },
					{ name: "idx_asc", columns: "created_at, id", unique: false },
				],
			}),
		).toEqual([]);
	});

	test("no indexes is not a finding", () => {
		expect(objectFindingsFor(indexDuplicate, { indexes: [] })).toEqual([]);
	});
});

describe("routine.definer-no-search-path", () => {
	const definer = `CREATE FUNCTION shop.f() RETURNS int
		LANGUAGE sql SECURITY DEFINER
		AS $$ SELECT 1 $$`;

	test("fires on security definer with no search_path", () => {
		const found = objectFindingsFor(routineDefinerNoSearchPath, {
			kind: "function",
			ddl: definer,
		});
		expect(found).toHaveLength(1);
		expect(found[0]?.severity).toBe("blocker");
		if (found[0]?.at.kind === "object") {
			expect(found[0].at.tab).toBe("ddl");
		}
	});

	test("does not fire when search_path is pinned", () => {
		expect(
			objectFindingsFor(routineDefinerNoSearchPath, {
				kind: "function",
				ddl: `${definer.replace("SECURITY DEFINER", "SECURITY DEFINER SET search_path = shop")}`,
			}),
		).toEqual([]);
	});

	test("does not fire on a security invoker routine", () => {
		expect(
			objectFindingsFor(routineDefinerNoSearchPath, {
				kind: "function",
				ddl: "CREATE FUNCTION shop.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
			}),
		).toEqual([]);
	});

	test("does not fire on a table", () => {
		expect(
			objectFindingsFor(routineDefinerNoSearchPath, {
				kind: "table",
				ddl: "create table x (a int) -- security definer",
			}),
		).toEqual([]);
	});

	test("stays silent with no definition to read", () => {
		// Calling a routine a vulnerability without having seen it would be
		// the worst wrong gripe in the catalogue.
		expect(
			objectFindingsFor(routineDefinerNoSearchPath, {
				kind: "function",
				ddl: null,
			}),
		).toEqual([]);
	});
});

describe("routine.volatile-but-readonly", () => {
	const readonly = `CREATE FUNCTION shop.total() RETURNS numeric
		LANGUAGE sql
		AS $$ SELECT sum(amount) FROM shop.orders $$`;

	test("fires on a read-only sql routine left volatile", () => {
		const found = objectFindingsFor(routineVolatileButReadonly, {
			kind: "function",
			ddl: readonly,
		});
		expect(found).toHaveLength(1);
		expect(found[0]?.severity).toBe("style");
	});

	test("does not fire when already stable or immutable", () => {
		for (const marking of ["STABLE", "IMMUTABLE"]) {
			expect(
				objectFindingsFor(routineVolatileButReadonly, {
					kind: "function",
					ddl: readonly.replace("LANGUAGE sql", `LANGUAGE sql ${marking}`),
				}),
			).toEqual([]);
		}
	});

	test("does not fire when the body writes", () => {
		expect(
			objectFindingsFor(routineVolatileButReadonly, {
				kind: "function",
				ddl: readonly.replace(
					"SELECT sum(amount) FROM shop.orders",
					"INSERT INTO shop.audit VALUES (1) RETURNING 1",
				),
			}),
		).toEqual([]);
	});

	test("does not fire when the body advances a sequence", () => {
		// nextval writes, however much it looks like a read.
		expect(
			objectFindingsFor(routineVolatileButReadonly, {
				kind: "function",
				ddl: readonly.replace("sum(amount)", "nextval('shop.ticket_seq')"),
			}),
		).toEqual([]);
	});

	test("stays silent on plpgsql, which can write invisibly", () => {
		// A plpgsql body can write through dynamic SQL that reading the
		// text will never reveal, so the rule declines to judge it.
		expect(
			objectFindingsFor(routineVolatileButReadonly, {
				kind: "function",
				ddl: readonly.replace("LANGUAGE sql", "LANGUAGE plpgsql"),
			}),
		).toEqual([]);
	});

	test("stays silent when the body executes dynamic SQL", () => {
		expect(
			objectFindingsFor(routineVolatileButReadonly, {
				kind: "function",
				ddl: readonly.replace("SELECT sum(amount)", "EXECUTE format('%s')"),
			}),
		).toEqual([]);
	});

	test("stays silent with no definition", () => {
		expect(
			objectFindingsFor(routineVolatileButReadonly, {
				kind: "function",
				ddl: null,
			}),
		).toEqual([]);
	});
});
