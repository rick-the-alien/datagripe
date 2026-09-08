import { describe, expect, test } from "bun:test";
import { accessFindingsFor } from "./fixtures";
import {
	GRANT_RULES,
	grantDefaultPrivilegesUntrusted,
	grantDefinerPublicReach,
	grantPublicExecute,
	grantRlsNoPolicy,
	grantUntrustedReadNoRls,
	grantUntrustedWrite,
	grantViewOwnerBypass,
} from "./grantRules";

/**
 * Three cases per rule, per the gripes testing rule: one that fires, one
 * that looks like the finding and is not, and one where the rule cannot
 * tell and must stay silent.
 *
 * The silent case is the same shape for all seven: **no role marked
 * untrusted**. DataGripe cannot know which of forty roles is the
 * PostgREST anonymous one, and a report that guesses either floods the
 * panel or silences the one role that mattered.
 */

const ANON_EXECUTE_ONE = {
	role: "anon",
	untrusted: true,
	privileges: ["execute"],
	blocked: false,
};
const ANON_SELECT_ONE = {
	role: "anon",
	untrusted: true,
	privileges: ["select"],
	blocked: false,
};
const ANON_EXECUTE = [ANON_EXECUTE_ONE];
const ANON_SELECT = [ANON_SELECT_ONE];
/** Same reach, but nobody has said this role is untrusted. */
const UNMARKED_EXECUTE = [
	{ role: "anon", untrusted: false, privileges: ["execute"], blocked: false },
];

describe("grant.public-execute", () => {
	test("fires when an untrusted role can execute a routine", () => {
		const findings = accessFindingsFor(grantPublicExecute, {
			kind: "function",
			name: "settle(integer)",
			reach: ANON_EXECUTE,
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]?.facts.role).toBe("anon");
	});

	test("stays silent when the role cannot enter the schema", () => {
		// The privilege is real and the grant exists; the role has no USAGE
		// on the schema, so it is not access. Reporting it would be the
		// report being wrong in the reassuring direction's mirror image.
		expect(
			accessFindingsFor(grantPublicExecute, {
				kind: "function",
				name: "settle(integer)",
				reach: [{ ...ANON_EXECUTE_ONE, blocked: true }],
			}),
		).toHaveLength(0);
	});

	test("stays silent when no role is marked untrusted", () => {
		expect(
			accessFindingsFor(grantPublicExecute, {
				kind: "function",
				name: "settle(integer)",
				reach: UNMARKED_EXECUTE,
			}),
		).toHaveLength(0);
	});
});

describe("grant.definer-public-reach", () => {
	test("fires on security definer plus untrusted reach", () => {
		expect(
			accessFindingsFor(grantDefinerPublicReach, {
				kind: "function",
				name: "settle(integer)",
				securityDefiner: true,
				reach: ANON_EXECUTE,
			}),
		).toHaveLength(1);
	});

	test("a definer routine nobody untrusted can call is not this finding", () => {
		expect(
			accessFindingsFor(grantDefinerPublicReach, {
				kind: "function",
				name: "settle(integer)",
				securityDefiner: true,
				reach: [{ ...ANON_EXECUTE_ONE, privileges: [] }],
			}),
		).toHaveLength(0);
	});

	test("an invoker routine anon can call is not this finding", () => {
		expect(
			accessFindingsFor(grantDefinerPublicReach, {
				kind: "function",
				name: "settle(integer)",
				securityDefiner: false,
				reach: ANON_EXECUTE,
			}),
		).toHaveLength(0);
	});
});

describe("grant.untrusted-write", () => {
	test("fires and names only the write privileges", () => {
		const findings = accessFindingsFor(grantUntrustedWrite, {
			reach: [
				{
					role: "anon",
					untrusted: true,
					privileges: ["select", "insert", "delete"],
					blocked: false,
				},
			],
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]?.facts.privileges).toBe("insert, delete");
	});

	test("read-only reach is not a write finding", () => {
		expect(
			accessFindingsFor(grantUntrustedWrite, { reach: ANON_SELECT }),
		).toHaveLength(0);
	});

	test("a routine is not a relation", () => {
		expect(
			accessFindingsFor(grantUntrustedWrite, {
				kind: "function",
				name: "settle(integer)",
				reach: ANON_EXECUTE,
			}),
		).toHaveLength(0);
	});
});

describe("grant.untrusted-read-no-rls", () => {
	test("fires when an untrusted role reads a table with RLS off", () => {
		expect(
			accessFindingsFor(grantUntrustedReadNoRls, {
				rls: "off",
				policyCount: 0,
				reach: ANON_SELECT,
			}),
		).toHaveLength(1);
	});

	test("the same reach with RLS forced is not this finding", () => {
		expect(
			accessFindingsFor(grantUntrustedReadNoRls, {
				rls: "forced",
				policyCount: 3,
				reach: ANON_SELECT,
			}),
		).toHaveLength(0);
	});

	test("stays silent when no role is marked untrusted", () => {
		expect(
			accessFindingsFor(grantUntrustedReadNoRls, {
				rls: "off",
				policyCount: 0,
				reach: [{ ...ANON_SELECT_ONE, untrusted: false }],
			}),
		).toHaveLength(0);
	});
});

describe("grant.rls-no-policy", () => {
	test("fires on RLS enabled with zero policies", () => {
		expect(
			accessFindingsFor(grantRlsNoPolicy, { rls: "on", policyCount: 0 }),
		).toHaveLength(1);
	});

	test("RLS off with zero policies is a different problem", () => {
		// Off-and-empty is `grant.untrusted-read-no-rls` territory. This rule
		// is about the opposite mistake, and firing on both would make the
		// two indistinguishable.
		expect(
			accessFindingsFor(grantRlsNoPolicy, { rls: "off", policyCount: 0 }),
		).toHaveLength(0);
	});

	test("RLS on with policies is fine", () => {
		expect(
			accessFindingsFor(grantRlsNoPolicy, { rls: "on", policyCount: 1 }),
		).toHaveLength(0);
	});
});

describe("grant.view-owner-bypass", () => {
	test("fires on a non-invoker view exposing an unreachable base table", () => {
		const findings = accessFindingsFor(grantViewOwnerBypass, {
			kind: "view",
			name: "v_orders",
			rls: "none",
			securityInvoker: false,
			viewBypass: [{ role: "anon", relation: "api.orders" }],
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]?.facts.relation).toBe("api.orders");
	});

	test("security_invoker=true reads as the caller, so there is no bypass", () => {
		expect(
			accessFindingsFor(grantViewOwnerBypass, {
				kind: "view",
				name: "v_orders",
				securityInvoker: true,
				viewBypass: [{ role: "anon", relation: "api.orders" }],
			}),
		).toHaveLength(0);
	});

	test("stays silent when the dependency read was unavailable", () => {
		// `null` is "not asked", not "nothing found". Treating the two the
		// same is how a rule starts firing on a guess.
		expect(
			accessFindingsFor(grantViewOwnerBypass, {
				kind: "view",
				name: "v_orders",
				securityInvoker: false,
				viewBypass: null,
			}),
		).toHaveLength(0);
	});
});

describe("grant.default-privileges-untrusted", () => {
	test("fires on a default ACL granting to an untrusted role", () => {
		const findings = accessFindingsFor(grantDefaultPrivilegesUntrusted, {
			defaultAclUntrusted: [{ grantee: "anon", objectType: "tables" }],
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]?.at.kind).toBe("datasource");
	});

	test("no default ACL entries is not a finding", () => {
		expect(
			accessFindingsFor(grantDefaultPrivilegesUntrusted, {
				defaultAclUntrusted: [],
			}),
		).toHaveLength(0);
	});
});

describe("every grant rule", () => {
	test("declares the access input and nothing else", () => {
		// A grant rule that also declared `statement` would run on every
		// keystroke and never have the access data it needs.
		for (const rule of GRANT_RULES) {
			expect(rule.inputs).toEqual(["access"]);
		}
	});

	test("stays silent on the harmless default fixture", () => {
		for (const rule of GRANT_RULES) {
			expect(accessFindingsFor(rule)).toHaveLength(0);
		}
	});
});
