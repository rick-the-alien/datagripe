import { describe, expect, test } from "bun:test";
import type { Domain, DomainTarget } from "@datagripe/contracts";
import { domainTargetKey } from "@datagripe/contracts";
import type { GroupedObject } from "./domainGrouping";
import {
	decodeDragPayload,
	domainIdForDrop,
	dragPayload,
	dropChangesAnything,
	encodeDragPayload,
	groupByDomain,
	initiallyCollapsed,
	isShelved,
	shelfIds,
	UNTAGGED_GROUP,
	visibleNodes,
} from "./domainGrouping";

/**
 * The grouped tree's arithmetic (docs/spec/domains.md "Sidebar",
 * "Sorting", "Hidden domains").
 *
 * These are the decisions that are invisible in a screenshot: whether a
 * drop moves seven objects or one, whether a shelf swallows the untagged
 * count, whether `untagged` is still last once shelves exist.
 */

function domain(name: string, overrides: Partial<Domain> = {}): Domain {
	return {
		id: `d-${name}`,
		name,
		colour: 1,
		description: "",
		includeData: false,
		hidden: false,
		sortOrder: 0,
		...overrides,
	};
}

function object(name: string, domainId: string | null): GroupedObject {
	return { schema: "public", name, kind: "table", domainId };
}

const AUTH = domain("auth");
const INBUILT = domain("inbuilt", { hidden: true });

describe("groupByDomain", () => {
	test("untagged is last and present even at zero", () => {
		const groups = groupByDomain([AUTH], [object("users", AUTH.id)]);
		expect(groups.map((group) => group.id)).toEqual([AUTH.id, UNTAGGED_GROUP]);
		expect(groups[1]?.members).toHaveLength(0);
	});

	test("shelves sort after the project's domains but before untagged", () => {
		const groups = groupByDomain(
			[INBUILT, AUTH],
			[object("users", AUTH.id), object("pg_stat_x", INBUILT.id)],
		);
		expect(groups.map((group) => group.name)).toEqual([
			"auth",
			"inbuilt",
			"untagged",
		]);
	});

	test("a shelved object does not land in untagged", () => {
		// The whole point of the shelf: `untagged` is the drift number, and
		// two hundred permanent residents would destroy it.
		const groups = groupByDomain(
			[INBUILT],
			[object("pg_stat_x", INBUILT.id), object("orders", null)],
		);
		const untagged = groups.find((group) => group.id === UNTAGGED_GROUP);
		expect(untagged?.members.map((member) => member.name)).toEqual(["orders"]);
	});

	test("a group with no members still renders, so fetching is not empty", () => {
		const groups = groupByDomain([AUTH], []);
		expect(groups).toHaveLength(2);
		expect(groups[0]?.members).toEqual([]);
	});
});

describe("initiallyCollapsed", () => {
	test("closes every shelf and nothing else", () => {
		expect(initiallyCollapsed([AUTH, INBUILT])).toEqual({ [INBUILT.id]: true });
	});
});

describe("isShelved", () => {
	const tags = { [domainTargetKey(object("pg_stat_x", null))]: INBUILT.id };
	const shelves = shelfIds([AUTH, INBUILT]);
	const base = {
		schema: "public",
		tags,
		shelves,
		showHidden: false,
		filtering: false,
	};

	test("hides an object tagged into a shelf", () => {
		expect(isShelved({ ...base, kind: "table", name: "pg_stat_x" })).toBe(true);
	});

	test("leaves an object in a visible domain alone", () => {
		expect(isShelved({ ...base, kind: "table", name: "users" })).toBe(false);
	});

	test("the peek shows everything", () => {
		expect(
			isShelved({
				...base,
				kind: "table",
				name: "pg_stat_x",
				showHidden: true,
			}),
		).toBe(false);
	});

	test("a filter overrides the shelf", () => {
		// Typing a name and not being shown the object you named is a bug.
		expect(
			isShelved({ ...base, kind: "table", name: "pg_stat_x", filtering: true }),
		).toBe(false);
	});

	test("a column row is never shelved, whatever it is called", () => {
		// Same schema, same name as the shelved table, different kind: the
		// key includes the kind, so this must not collide.
		expect(isShelved({ ...base, kind: "column", name: "pg_stat_x" })).toBe(
			false,
		);
	});
});

describe("visibleNodes", () => {
	const nodes = [
		{ kind: "table", name: "users" },
		{ kind: "table", name: "pg_stat_x" },
	];
	const args = {
		schema: "public",
		tags: { [domainTargetKey(object("pg_stat_x", null))]: INBUILT.id },
		shelves: shelfIds([INBUILT]),
		showHidden: false,
		filtering: false,
	};

	test("drops the shelved node", () => {
		expect(visibleNodes(nodes, args).map((node) => node.name)).toEqual([
			"users",
		]);
	});

	test("returns the same array when there is nothing to shelve", () => {
		// Referential stability: a fresh array every render is a fresh
		// snapshot every render, and React loops on it.
		const untouched = { ...args, shelves: new Set<string>() };
		expect(visibleNodes(nodes, untouched)).toBe(nodes);
	});
});

describe("domainIdForDrop", () => {
	test("the untagged bucket means untag", () => {
		expect(domainIdForDrop(UNTAGGED_GROUP)).toBeNull();
	});

	test("a domain group means that domain", () => {
		expect(domainIdForDrop(AUTH.id)).toBe(AUTH.id);
	});
});

describe("dragPayload", () => {
	const users = object("users", null);
	const orders = object("orders", null);
	const usersKey = domainTargetKey(users);
	const ordersKey = domainTargetKey(orders);

	test("a row outside the selection moves alone", () => {
		// The pointer is the more specific statement. Silently moving two
		// hundred still-selected objects is the failure this prevents.
		const payload = dragPayload(usersKey, users, { [ordersKey]: orders });
		expect(payload).toEqual([users]);
	});

	test("a row inside the selection moves the whole selection", () => {
		const payload = dragPayload(usersKey, users, {
			[usersKey]: users,
			[ordersKey]: orders,
		});
		expect(payload).toHaveLength(2);
	});

	test("with no selection it moves the row", () => {
		expect(dragPayload(usersKey, users, {})).toEqual([users]);
	});
});

describe("dropChangesAnything", () => {
	const users = object("users", null);
	const tags = { [domainTargetKey(users)]: AUTH.id };

	test("re-dropping into the same domain changes nothing", () => {
		expect(dropChangesAnything([users], tags, AUTH.id)).toBe(false);
	});

	test("moving to another domain changes something", () => {
		expect(dropChangesAnything([users], tags, INBUILT.id)).toBe(true);
	});

	test("dropping an untagged object onto untagged changes nothing", () => {
		expect(dropChangesAnything([users], {}, null)).toBe(false);
	});

	test("one mover in a batch is enough", () => {
		const orders = object("orders", null);
		expect(dropChangesAnything([users, orders], tags, AUTH.id)).toBe(true);
	});
});

describe("the drag payload round trip", () => {
	test("survives encode and decode", () => {
		const targets: DomainTarget[] = [
			{ schema: "public", name: "users", kind: "table" },
		];
		expect(decodeDragPayload(encodeDragPayload(targets))).toEqual(targets);
	});

	test("rejects anything else a drop might carry", () => {
		// A drop can come from another tab or another application, and this
		// ends in a write to `domain.tag`.
		expect(decodeDragPayload("not json")).toBeNull();
		expect(decodeDragPayload("[]")).toBeNull();
		expect(decodeDragPayload('[{"schema":"public"}]')).toBeNull();
		expect(
			decodeDragPayload('[{"schema":"p","name":"u","kind":"trigger"}]'),
		).toBeNull();
	});
});
