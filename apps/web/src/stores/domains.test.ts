import { describe, expect, test } from "bun:test";
import type { DomainsState } from "./domains";
import {
	domainColourVar,
	NO_DOMAINS,
	NO_TAGS,
	selectDomainId,
	selectDomains,
	selectTags,
} from "./domains";

/**
 * Selector stability.
 *
 * zustand compares snapshots by identity, so a selector that builds a
 * value must return the *same* value when nothing changed. A selector
 * returning `?? []`, or assembling `{ colour, name }` from two lookups,
 * hands React a new object every render and it re-renders forever —
 * surfacing as "Maximum update depth exceeded" pointing at the
 * component rather than at the selector that caused it.
 *
 * These are cheap assertions for a failure that is expensive to debug,
 * and they are the reason the rail joins its two lookups in render
 * rather than inside a selector.
 */

const REF = "local-demo";
const KEY = "table:public.users";

function stateWith(overrides: Partial<DomainsState> = {}): DomainsState {
	return {
		byConnection: {},
		tagsByConnection: {},
		loaded: {},
		grouped: false,
		showHidden: false,
		load: async () => {},
		upsert: async () => {
			throw new Error("not used");
		},
		remove: async () => 0,
		tag: async () => {},
		setGrouped: () => {},
		setShowHidden: () => {},
		reset: () => {},
		...overrides,
	};
}

describe("selectDomains", () => {
	test("returns the identical empty array for an unloaded connection", () => {
		const select = selectDomains(REF);
		const state = stateWith();
		expect(select(state)).toBe(select(state));
		expect(select(state)).toBe(NO_DOMAINS);
	});

	test("returns the stored array by reference once loaded", () => {
		const domains = [
			{
				id: "d1",
				name: "auth",
				colour: 1,
				description: "",
				includeData: false,
				hidden: false,
				sortOrder: 0,
			},
		];
		const state = stateWith({ byConnection: { [REF]: domains } });
		expect(selectDomains(REF)(state)).toBe(domains);
	});
});

describe("selectTags", () => {
	test("returns the identical empty record for an unloaded connection", () => {
		const select = selectTags(REF);
		const state = stateWith();
		expect(select(state)).toBe(select(state));
		expect(select(state)).toBe(NO_TAGS);
	});
});

describe("selectDomainId", () => {
	test("is a primitive, so it is stable by value", () => {
		const state = stateWith({
			tagsByConnection: { [REF]: { [KEY]: "d1" } },
		});
		expect(selectDomainId(REF, KEY)(state)).toBe("d1");
	});

	test("an untagged object selects null, not undefined", () => {
		// `undefined` from a selector is indistinguishable from "not
		// subscribed" in some readings; null says "asked, and none".
		expect(selectDomainId(REF, KEY)(stateWith())).toBeNull();
	});
});

describe("domainColourVar", () => {
	test("clamps to the eight palette slots", () => {
		expect(domainColourVar(1)).toBe("var(--dg-domain-1)");
		expect(domainColourVar(8)).toBe("var(--dg-domain-8)");
		expect(domainColourVar(0)).toBe("var(--dg-domain-1)");
		expect(domainColourVar(99)).toBe("var(--dg-domain-8)");
	});
});
