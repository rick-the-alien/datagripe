import { describe, expect, test } from "bun:test";
import {
	completionContext,
	parseStatementTables,
	unquoteIdentifier,
} from "./context";

describe("unquoteIdentifier", () => {
	test("strips quotes and unescapes doubled quotes", () => {
		expect(unquoteIdentifier('"order items"')).toBe("order items");
		expect(unquoteIdentifier('"say ""hi"""')).toBe('say "hi"');
		expect(unquoteIdentifier("plain")).toBe("plain");
	});
});

describe("parseStatementTables", () => {
	test("plain FROM clause", () => {
		const { tables, aliasToTable } = parseStatementTables(
			"SELECT * FROM users",
		);
		expect(tables).toEqual([{ schema: undefined, name: "users" }]);
		expect(aliasToTable.get("users")).toEqual({
			schema: undefined,
			name: "users",
		});
	});

	test("bare and AS aliases", () => {
		const { tables, aliasToTable } = parseStatementTables(
			"SELECT u.id FROM users u JOIN orders AS o ON o.user_id = u.id",
		);
		expect(tables).toEqual([
			{ schema: undefined, name: "users", alias: "u" },
			{ schema: undefined, name: "orders", alias: "o" },
		]);
		expect(aliasToTable.get("u")).toEqual({ schema: undefined, name: "users" });
		expect(aliasToTable.get("o")).toEqual({
			schema: undefined,
			name: "orders",
		});
	});

	test("schema-qualified references", () => {
		const { tables } = parseStatementTables(
			"SELECT * FROM app.orders o WHERE o.id IN (SELECT 1)",
		);
		expect(tables).toEqual([{ schema: "app", name: "orders", alias: "o" }]);
	});

	test("comma joins collect every table", () => {
		const { tables } = parseStatementTables(
			"SELECT * FROM users u, orders o, products",
		);
		expect(tables.map((table) => table.name)).toEqual([
			"users",
			"orders",
			"products",
		]);
	});

	test("double-quoted identifiers, including dots inside quotes", () => {
		const { tables, aliasToTable } = parseStatementTables(
			'SELECT * FROM "my.schema"."order items" AS oi',
		);
		expect(tables).toEqual([
			{ schema: "my.schema", name: "order items", alias: "oi" },
		]);
		expect(aliasToTable.get("oi")).toEqual({
			schema: "my.schema",
			name: "order items",
		});
	});

	test("keywords inside strings and comments are ignored", () => {
		const { tables } = parseStatementTables(
			"SELECT 'FROM fake' AS txt FROM users -- JOIN nope\n/* JOIN also_nope */",
		);
		expect(tables.map((table) => table.name)).toEqual(["users"]);
	});

	test("UPDATE and INSERT INTO introduce tables", () => {
		expect(
			parseStatementTables("UPDATE accounts SET balance = 0").tables.map(
				(table) => table.name,
			),
		).toEqual(["accounts"]);
		expect(
			parseStatementTables("INSERT INTO logs (a, b) VALUES (1, 2)").tables.map(
				(table) => table.name,
			),
		).toEqual(["logs"]);
	});

	test("a clause keyword is never taken as an alias", () => {
		const { tables } = parseStatementTables(
			"SELECT * FROM users WHERE id = 1 ORDER BY id",
		);
		expect(tables).toEqual([{ schema: undefined, name: "users" }]);
	});
});

describe("completionContext", () => {
	test("dot after an alias", () => {
		expect(completionContext("SELECT * FROM users u WHERE u.", "")).toEqual({
			kind: "dot",
			qualifier: "u",
		});
	});

	test("dot after a quoted alias", () => {
		expect(
			completionContext('SELECT * FROM users AS "u" WHERE "u".', ""),
		).toEqual({ kind: "dot", qualifier: "u" });
	});

	test("dot after a schema name", () => {
		expect(completionContext("SELECT * FROM app.", "")).toEqual({
			kind: "dot",
			qualifier: "app",
		});
	});

	test("FROM position, empty and after a comma join", () => {
		expect(completionContext("SELECT * FROM ", "")).toEqual({
			kind: "tablePosition",
		});
		expect(completionContext("SELECT * FROM users, ", "")).toEqual({
			kind: "tablePosition",
		});
		expect(completionContext("SELECT * FROM users u JOIN ", "")).toEqual({
			kind: "tablePosition",
		});
	});

	test("UPDATE / INTO positions", () => {
		expect(completionContext("UPDATE ", "")).toEqual({
			kind: "tablePosition",
		});
		expect(completionContext("INSERT INTO ", "")).toEqual({
			kind: "tablePosition",
		});
		expect(completionContext("TRUNCATE ", "")).toEqual({
			kind: "tablePosition",
		});
	});

	test("general positions", () => {
		expect(completionContext("SELECT ", "")).toEqual({ kind: "general" });
		expect(completionContext("SELECT * FROM users u WHERE ", "")).toEqual({
			kind: "general",
		});
		expect(completionContext("UPDATE users SET ", "")).toEqual({
			kind: "general",
		});
		expect(completionContext("", "")).toEqual({ kind: "general" });
	});

	test("dots inside strings do not trigger dot context", () => {
		expect(completionContext("SELECT 'a.' ", "")).toEqual({
			kind: "general",
		});
	});
});
