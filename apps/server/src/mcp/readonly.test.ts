import { describe, expect, test } from "bun:test";
import { refusalMessage, refuseWrites } from "./readonly";

/**
 * Layer 1 of read-only mode (docs/spec/mcp.md "Read-only"). The table is
 * the spec: each statement either runs in a read-only project or it does
 * not, and a change that quietly moves one from one column to the other
 * is the failure this file exists to catch.
 */

const READS = [
	"select 1",
	"SELECT * FROM orders WHERE note = 'drop table orders'",
	"-- delete everything\nselect count(*) from t",
	"with recent as (select * from t) select * from recent",
	"values (1), (2)",
	"table orders",
	"explain select * from t",
	"show search_path",
	"select replace(note, 'a', 'b') from t",
	"select comment from tickets",
	'select "update" from t',
	"select created_at, deleted_at from audit",
	"select nextval_safe from t",
];

const WRITES: Array<[string, string]> = [
	["insert into t values (1)", "insert"],
	["update t set a = 1", "update"],
	["delete from t where id = 1", "delete"],
	["truncate t", "truncate"],
	["drop table t", "drop"],
	["create table t (a int)", "create"],
	["alter table t add column b int", "alter"],
	["grant select on t to anon", "grant"],
	["revoke select on t from anon", "revoke"],
	// Starts with an allowed word and writes: the case a leading-word
	// check alone would let through.
	[
		"with w as (insert into t values (1) returning *) select * from w",
		"insert",
	],
	["select * from t for update", "update"],
	["select * into copy_of_t from t", "into"],
	["do $$ begin perform 1; end $$", "do"],
	["call rebuild()", "call"],
	["copy t to program 'sh -c whoami'", "copy"],
	["explain analyze select * from t", "analyze"],
	["vacuum full t", "vacuum"],
	["lock table t", "lock"],
	["pragma journal_mode = wal", "pragma"],
	["commit", "commit"],
	// Two statements, the second one a write: every statement is checked,
	// not only the first.
	["select 1; drop table t", "drop"],
];

describe("read-only classification", () => {
	for (const sql of READS) {
		test(`allows ${sql.replace(/\n/g, " ")}`, () => {
			expect(refuseWrites(sql, "postgres")).toBeNull();
		});
	}

	for (const [sql, word] of WRITES) {
		test(`refuses ${sql.replace(/\n/g, " ")}`, () => {
			const refusal = refuseWrites(sql, "postgres");
			expect(refusal).not.toBeNull();
			expect(refusal?.word).toBe(word);
		});
	}

	test("the refusal names the toggle, so an agent can ask for it", () => {
		const refusal = refuseWrites("delete from t", "postgres");
		expect(refusal).not.toBeNull();
		const message = refusalMessage(refusal as NonNullable<typeof refusal>);
		expect(message).toContain("read-only");
		expect(message).toContain("mcp panel");
		expect(message).toContain("delete");
	});

	test("a statement of only comments is neither run nor refused", () => {
		expect(refuseWrites("-- nothing here", "postgres")).toBeNull();
	});

	test("backticked identifiers are names, not keywords (mysql)", () => {
		expect(refuseWrites("select `update` from t", "mysql")).toBeNull();
	});
});
