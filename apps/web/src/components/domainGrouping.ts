import type { Domain, DomainTarget, ObjectKind } from "@datagripe/contracts";
import { domainTargetKey, domainTargetSchema } from "@datagripe/contracts";

/**
 * The grouped tree's arithmetic, kept out of the component
 * (docs/spec/domains.md "Sidebar", "Hidden domains").
 *
 * Grouping, shelving and the drag payload are all decisions about lists
 * that are easy to get subtly wrong and impossible to eyeball in a
 * sidebar: a drop that silently no-ops, a hidden group that swallows the
 * untagged count, a drag that moves one row when seven were selected.
 * They live here so a test can assert them directly.
 */

/** The synthetic group id for objects no domain claims. */
export const UNTAGGED_GROUP = "__untagged";

/** The dataTransfer type a domain drag carries. */
export const DOMAIN_DRAG_MIME = "application/x-datagripe-domain-targets";

export interface GroupedObject extends DomainTarget {
	domainId: string | null;
}

export interface DomainGroup {
	/** A domain id, or `UNTAGGED_GROUP`. */
	id: string;
	name: string;
	/** Palette slot, or null for the untagged bucket, which has no rail. */
	colour: number | null;
	hidden: boolean;
	description: string;
	members: GroupedObject[];
}

/**
 * Groups in render order: the project's domains first, then the shelves,
 * then untagged.
 *
 * `untagged` stays **last and always present, even at zero** — it is the
 * drift number, and a bucket that vanishes when empty is a bucket you
 * stop trusting. The shelves sit above it rather than below because
 * untagged is the row people act on, and a fixed final row is easier to
 * find than one that moves as shelves come and go.
 */
export function groupByDomain(
	domains: readonly Domain[],
	objects: readonly GroupedObject[],
): DomainGroup[] {
	const members = new Map<string, GroupedObject[]>();
	const untagged: GroupedObject[] = [];
	for (const object of objects) {
		if (object.domainId === null) {
			untagged.push(object);
			continue;
		}
		const list = members.get(object.domainId) ?? [];
		list.push(object);
		members.set(object.domainId, list);
	}

	const toGroup = (domain: Domain): DomainGroup => ({
		id: domain.id,
		name: domain.name,
		colour: domain.colour,
		hidden: domain.hidden,
		description: domain.description,
		members: members.get(domain.id) ?? [],
	});

	return [
		...domains.filter((domain) => !domain.hidden).map(toGroup),
		...domains.filter((domain) => domain.hidden).map(toGroup),
		{
			id: UNTAGGED_GROUP,
			name: "untagged",
			colour: null,
			hidden: false,
			description: "",
			members: untagged,
		},
	];
}

/** Groups that start closed: every shelf, and nothing else. */
export function initiallyCollapsed(
	domains: readonly Domain[],
): Record<string, boolean> {
	const collapsed: Record<string, boolean> = {};
	for (const domain of domains) {
		if (domain.hidden) {
			collapsed[domain.id] = true;
		}
	}
	return collapsed;
}

/** The domain ids that are shelves. */
export function shelfIds(domains: readonly Domain[]): Set<string> {
	return new Set(
		domains.filter((domain) => domain.hidden).map((domain) => domain.id),
	);
}

/**
 * Whether a schema-tree row is shelved out of sight.
 *
 * A filter overrides the shelf: typing a name and not being shown the
 * object you named is a bug, not a feature. The row still renders dimmed
 * (see `dg-tree-row-shelved`), so the answer is never a lie about where
 * the object lives.
 */
export function isShelved(args: {
	kind: string;
	schema: string;
	name: string;
	tags: Readonly<Record<string, string>>;
	shelves: ReadonlySet<string>;
	showHidden: boolean;
	filtering: boolean;
}): boolean {
	if (args.showHidden || args.filtering || args.shelves.size === 0) {
		return false;
	}
	// Only object kinds are ever tagged, so a category or column row
	// simply misses the lookup rather than needing to be excluded first.
	const key = domainTargetKey({
		schema: args.schema,
		name: args.name,
		kind: args.kind as ObjectKind,
	});
	const domainId = args.tags[key];
	return domainId !== undefined && args.shelves.has(domainId);
}

/** The domain a drop onto this group means. `null` untags. */
export function domainIdForDrop(groupId: string): string | null {
	return groupId === UNTAGGED_GROUP ? null : groupId;
}

/**
 * What a drag carries.
 *
 * If the dragged row is part of a live multi-selection the whole
 * selection moves, matching the context menu (docs/spec/domains.md
 * "Context menu"). Dragging a row that is *not* in the selection moves
 * that row alone — the pointer is the more specific statement, and
 * silently moving two hundred other objects because they were still
 * selected is the failure this rule exists to prevent.
 */
export function dragPayload(
	rowKey: string,
	target: DomainTarget,
	multiSelected: Readonly<Record<string, DomainTarget>>,
): DomainTarget[] {
	if (multiSelected[rowKey] === undefined) {
		return [target];
	}
	return Object.values(multiSelected);
}

/** Whether the drop would change any tag. All already there → no-op. */
export function dropChangesAnything(
	targets: readonly DomainTarget[],
	tags: Readonly<Record<string, string>>,
	destination: string | null,
): boolean {
	return targets.some(
		(target) => (tags[domainTargetKey(target)] ?? null) !== destination,
	);
}

export function encodeDragPayload(targets: readonly DomainTarget[]): string {
	return JSON.stringify(targets);
}

/**
 * Reads a drop back, or null.
 *
 * Validated rather than trusted: a drop can carry anything from anywhere
 * — another tab, another application — and this ends in a write to
 * `domain.tag`.
 */
export function decodeDragPayload(raw: string): DomainTarget[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const result = domainTargetSchema.array().min(1).safeParse(parsed);
	return result.success ? result.data : null;
}

/**
 * The rows a schema-tree level actually shows.
 *
 * Returns the input array itself when nothing is shelved, so the common
 * case allocates nothing and the reference stays stable for React.
 */
export function visibleNodes<T extends { kind: string; name: string }>(
	nodes: readonly T[],
	args: {
		schema: string;
		tags: Readonly<Record<string, string>>;
		shelves: ReadonlySet<string>;
		showHidden: boolean;
		filtering: boolean;
	},
): readonly T[] {
	if (args.showHidden || args.filtering || args.shelves.size === 0) {
		return nodes;
	}
	return nodes.filter(
		(node) =>
			!isShelved({
				kind: node.kind,
				schema: args.schema,
				name: node.name,
				tags: args.tags,
				shelves: args.shelves,
				showHidden: args.showHidden,
				filtering: args.filtering,
			}),
	);
}
