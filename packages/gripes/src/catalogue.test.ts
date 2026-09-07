import { describe, expect, test } from "bun:test";
import { ATTITUDE_LEVELS } from "@datagripe/contracts";
import { RULES } from "./catalogue";
import { MESSAGES } from "./messages";
import { renderFinding, renderFooter } from "./render";
import { objectFor, schemaFor } from "./rules/fixtures";
import { runRules } from "./runner";
import { statementInputFor } from "./statement";

/**
 * The real catalogue over real input, rendered at every level.
 *
 * Each rule's own test proves it fires; this proves it is *wired* —
 * registered in `RULES`, worded in `MESSAGES`, and renderable. Those
 * are four separate edits per rule (docs/spec/gripes.md), and forgetting
 * one of them is the likeliest mistake when adding one.
 */

/** A table with no key and one redundant index. */
const OFFENDING_TABLE = objectFor({
	kind: "table",
	columns: [{ name: "label", primaryKey: false, nullable: true }],
	indexes: [
		{ name: "idx_a", columns: "user_id", unique: false },
		{ name: "idx_ab", columns: "user_id, created_at", unique: false },
	],
});

/** A definer routine with no search_path, whose body only reads. */
const OFFENDING_ROUTINE = objectFor({
	kind: "function",
	ddl: `CREATE FUNCTION shop.total() RETURNS numeric
		LANGUAGE sql SECURITY DEFINER
		AS $$ SELECT sum(amount) FROM shop.orders $$`,
});

/** SQL that trips every statement rule in the catalogue. */
const OFFENDING = [
	"select * from a join b",
	"delete from payments",
	"update payments set status = 'void'",
	"select * from users where id not in (select user_id from bans)",
	"create view v as select * from orders",
	"create index idx_orders_user on orders (user_id)",
	"select id from orders where status <> 'void'",
].join(";\n");

/** The only schema facts the fixtures above rely on. */
const KNOWN_SCHEMA = schemaFor({
	nullable: { ".orders.status": true },
});

/** Every finding the catalogue produces over the fixtures above. */
function allFindings() {
	const findings = [];
	let offset = 0;
	for (const text of OFFENDING.split(";\n")) {
		findings.push(
			...runRules(RULES, {
				schema: KNOWN_SCHEMA,
				statement: statementInputFor({
					documentId: "doc-1",
					dialect: "postgres",
					text,
					offset,
				}),
			}).findings,
		);
		offset += text.length + 2;
	}
	for (const object of [OFFENDING_TABLE, OFFENDING_ROUTINE]) {
		findings.push(...runRules(RULES, { object }).findings);
	}
	return findings;
}

describe("the catalogue, end to end", () => {
	test("every rule fires on something in the fixtures", () => {
		// A rule in RULES that nothing here trips is either unreachable or
		// missing its fixture, and both are silent failures otherwise.
		const fired = new Set(allFindings().map((finding) => finding.ruleId));
		expect([...fired].sort()).toEqual(RULES.map((rule) => rule.id).sort());
	});

	test("nothing fires on innocent SQL", () => {
		const result = runRules(RULES, {
			schema: KNOWN_SCHEMA,
			statement: statementInputFor({
				documentId: "doc-1",
				dialect: "postgres",
				text: "select o.id, o.total from orders o join users u on u.id = o.user_id where o.total > 0",
			}),
		});
		expect(result.findings).toEqual([]);
	});

	test("nothing fires on an object with nothing wrong with it", () => {
		const result = runRules(RULES, {
			object: objectFor({
				indexes: [{ name: "idx_user", columns: "user_id", unique: false }],
			}),
		});
		expect(result.findings).toEqual([]);
	});

	test("every finding renders at every level with no placeholder left", () => {
		for (const finding of allFindings()) {
			for (const level of ATTITUDE_LEVELS) {
				const text = renderFinding(finding, level, MESSAGES);
				// An unresolved `{fact}` means the rule and its wording
				// disagree about what the rule knows.
				expect(text).not.toInclude("{");
				expect(text.trim()).not.toBe("");
			}
			expect(renderFooter(finding)).toStartWith(finding.severity);
		}
	});
});
