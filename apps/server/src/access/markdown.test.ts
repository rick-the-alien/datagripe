import { describe, expect, test } from "bun:test";
import type { AccessObject, Finding } from "@datagripe/contracts";
import {
	renderCell,
	renderDefaultAcl,
	renderFindings,
	renderMatrix,
	renderPolicies,
} from "./markdown";

/**
 * The `access/` markdown (docs/spec/access-report.md "Export").
 *
 * The rule these tests exist for: **no date in the body.** A
 * `Generated: <date>` line dirties both files on every run and buries
 * the diff that would have told you `anon` gained `UPDATE` last Tuesday.
 */

function object(overrides: Partial<AccessObject> = {}): AccessObject {
	return {
		schema: "api",
		name: "orders",
		kind: "table",
		owner: "api_owner",
		cells: [],
		rls: "off",
		policyCount: 0,
		securityInvoker: null,
		securityDefiner: null,
		searchPathPinned: null,
		hasColumnGrants: false,
		domain: null,
		...overrides,
	};
}

const VIA_PUBLIC = {
	role: "anon",
	privileges: ["select" as const],
	sources: ["public" as const],
	path: "via PUBLIC",
	schemaBlocked: false,
};

describe("renderCell", () => {
	test("marks a privilege reachable without a direct grant", () => {
		expect(renderCell(VIA_PUBLIC)).toBe("R°");
	});

	test("a direct grant gets no marker", () => {
		expect(renderCell({ ...VIA_PUBLIC, sources: ["direct"], path: null })).toBe(
			"R",
		);
	});

	test("a schema-blocked privilege is struck, not hidden", () => {
		// "Granted but unreachable" and "not granted" are different facts.
		expect(renderCell({ ...VIA_PUBLIC, schemaBlocked: true })).toBe("~~R~~");
	});

	test("no privileges renders as a dash", () => {
		expect(renderCell({ ...VIA_PUBLIC, privileges: [] })).toBe("–");
	});
});

describe("renderMatrix", () => {
	const objects = [
		object({ cells: [VIA_PUBLIC], domain: "reference" }),
		object({
			schema: "api",
			name: "settle(integer)",
			kind: "function",
			securityDefiner: true,
			searchPathPinned: false,
			rls: "none",
			cells: [{ ...VIA_PUBLIC, privileges: ["execute"] }],
		}),
	];

	test("carries no date and no 'Generated' line", () => {
		const text = renderMatrix(["anon"], objects);
		expect(text).not.toContain(new Date().getFullYear().toString());
		expect(text).not.toMatch(/generated/i);
	});

	test("explains every marker in a Paths section", () => {
		// Markdown has no hover, so the path that makes the report useful
		// needs somewhere to live.
		const text = renderMatrix(["anon"], objects);
		expect(text).toContain("## Paths");
		expect(text).toContain("via PUBLIC");
	});

	test("says so plainly when nothing is indirect", () => {
		const text = renderMatrix(
			["anon"],
			[object({ cells: [{ ...VIA_PUBLIC, sources: ["direct"], path: null }] })],
		);
		expect(text).toContain("granted to its role by name");
	});

	test("a role with no cell on an object renders as no access", () => {
		const text = renderMatrix(["anon", "reporting"], objects);
		expect(text).toContain("–");
	});

	test("routines and relations are separate tables", () => {
		const text = renderMatrix(["anon"], objects);
		expect(text).toContain("## Tables and views");
		expect(text).toContain("## Routines");
	});

	test("is byte-identical across two renders", () => {
		expect(renderMatrix(["anon"], objects)).toBe(
			renderMatrix(["anon"], objects),
		);
	});
});

describe("renderPolicies", () => {
	test("distinguishes no policies from no row-level security", () => {
		// The two are opposite problems and the empty file must not read as
		// reassurance.
		expect(renderPolicies([])).toContain("denies every row");
	});

	test("includes the expression verbatim", () => {
		const text = renderPolicies([
			{
				schema: "api",
				table: "orders",
				name: "own_rows",
				roles: ["authed"],
				command: "SELECT",
				using: "user_id = current_user_id()",
				withCheck: null,
			},
		]);
		expect(text).toContain("user_id = current_user_id()");
		expect(text).not.toContain("WITH CHECK");
	});
});

describe("renderDefaultAcl", () => {
	test("names it as an audit you do forever", () => {
		expect(renderDefaultAcl([])).toContain("audit you do forever");
	});

	test("lists an entry with its grantee", () => {
		const text = renderDefaultAcl([
			{
				owner: "api",
				schema: "public",
				objectType: "tables",
				grantee: "anon",
				privileges: ["select"],
			},
		]);
		expect(text).toContain("| api | public | tables | anon | select |");
	});
});

describe("renderFindings", () => {
	const finding: Finding = {
		ruleId: "grant.public-execute",
		severity: "blocker",
		at: {
			kind: "object",
			connectionId: "c",
			schema: "api",
			name: "settle(integer)",
			objectKind: "function",
			tab: "grants",
		},
		facts: { routine: "settle(integer)", role: "anon" },
	};

	test("renders at notice — the repository is the wrong place to shout", () => {
		const text = renderFindings([finding], []);
		expect(text).toContain("executable by PUBLIC");
		// `notice` is profanity-free by catalogue assertion; this checks the
		// level actually chosen, not the wording.
		expect(text).not.toContain("You did not grant this");
	});

	test("lists dismissed findings rather than omitting them", () => {
		// A dismissal is a decision, and the repository should record that
		// somebody made it.
		const text = renderFindings(
			[finding],
			[{ ruleId: "grant.public-execute", scope: "project", key: null }],
		);
		expect(text).toContain("## Dismissed");
		expect(text).toContain("acceptable");
	});

	test("nothing to report is stated, not left blank", () => {
		expect(renderFindings([], [])).toContain("Nothing to report");
	});

	test("carries no date", () => {
		expect(renderFindings([finding], [])).not.toContain(
			new Date().getFullYear().toString(),
		);
	});
});
