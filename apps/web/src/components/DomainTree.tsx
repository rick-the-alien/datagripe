import type {
	Domain,
	DomainTarget,
	ObjectKind,
	SchemaPathSegment,
} from "@datagripe/contracts";
import { domainTargetKey } from "@datagripe/contracts";
import { useEffect, useMemo, useState } from "react";
import { openObjectView, openTableView } from "../app/viewPanels";
import {
	domainColourVar,
	selectDomains,
	selectTags,
	useDomainsStore,
} from "../stores/domains";
import { nodeKey, useExplorerStore } from "../stores/runtime";

/**
 * The tree, grouped by domain (docs/spec/domains.md "Sidebar").
 *
 * A view mode, not a filter: every object stays reachable in both, and
 * the untagged bucket is **always present and always last**, even at
 * zero. Its count is the number that matters — it is the drift a
 * hand-maintained script could never show, because a script silently
 * omits every object added since somebody last edited its map.
 *
 * Object rows here are schema-qualified, because the point of a domain
 * is that it crosses namespaces.
 */

/** Tree categories that hold taggable objects, and the kind each yields. */
const CATEGORIES: Array<{ category: string; kind: ObjectKind }> = [
	{ category: "tables", kind: "table" },
	{ category: "views", kind: "view" },
	{ category: "functions", kind: "function" },
	{ category: "procedures", kind: "procedure" },
	{ category: "sequences", kind: "sequence" },
];

const GLYPHS: Record<ObjectKind, string> = {
	table: "▤",
	view: "◫",
	function: "ƒ",
	procedure: "ƒ",
	sequence: "№",
};

export interface GroupedObject extends DomainTarget {
	domainId: string | null;
}

/**
 * Grouping needs the whole object list, so switching to this mode forces
 * the lazy category loads the tree would otherwise defer. Categories
 * still resolve one at a time, and the rows appear as they land — a
 * group that is still fetching must not look like an empty one.
 */
function useAllObjects(
	connectionId: string,
	schema: string,
): { objects: GroupedObject[]; loading: boolean } {
	const ensure = useExplorerStore((state) => state.ensure);
	const children = useExplorerStore((state) => state.children);
	const tags = useDomainsStore(selectTags(connectionId));

	useEffect(() => {
		for (const { category } of CATEGORIES) {
			void ensure(connectionId, [
				{ kind: "schema", name: schema },
				{ kind: category as SchemaPathSegment["kind"], name: category },
			]);
		}
	}, [connectionId, schema, ensure]);

	return useMemo(() => {
		const objects: GroupedObject[] = [];
		let loading = false;
		for (const { category, kind } of CATEGORIES) {
			const key = nodeKey(connectionId, [
				{ kind: "schema", name: schema },
				{ kind: category as SchemaPathSegment["kind"], name: category },
			]);
			const state = children[key];
			if (state === undefined || state.status === "loading") {
				loading = true;
				continue;
			}
			if (state.status === "error") {
				// A category this engine does not have is not a failure worth
				// reporting here; the ungrouped tree already says so.
				continue;
			}
			for (const node of state.nodes) {
				const target: DomainTarget = { schema, name: node.name, kind };
				objects.push({
					...target,
					domainId: tags[domainTargetKey(target)] ?? null,
				});
			}
		}
		objects.sort(
			(a, b) =>
				a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name),
		);
		return { objects, loading };
	}, [children, connectionId, schema, tags]);
}

function ObjectRow(props: {
	connectionId: string;
	object: GroupedObject;
	colour: string | null;
	depth: number;
}) {
	const target = {
		connectionId: props.connectionId,
		schema: props.object.schema,
		name: props.object.name,
		kind: props.object.kind,
	};
	return (
		<div
			className="dg-tree-row dg-domain-object"
			style={{
				paddingLeft: 10 + props.depth * 14,
				...(props.colour === null
					? {}
					: ({ "--dg-domain-rail": props.colour } as React.CSSProperties)),
			}}
			role="treeitem"
			aria-selected={false}
			tabIndex={0}
			onDoubleClick={() => {
				if (props.object.kind === "table" || props.object.kind === "view") {
					openTableView(target);
				} else {
					openObjectView(target, "ddl");
				}
			}}
		>
			<span className="dg-tree-label">
				<span className="dg-tree-glyph">{GLYPHS[props.object.kind]}</span>
				{/* Schema-qualified: the point of a domain is that it crosses
				    namespaces, so an unqualified name here would be ambiguous. */}
				<span className="dg-domain-qualified">{props.object.schema}.</span>
				{props.object.name}
			</span>
		</div>
	);
}

export function DomainGroups(props: {
	connectionId: string;
	schema: string;
	filter: string;
}) {
	const domains = useDomainsStore(selectDomains(props.connectionId));
	const { objects, loading } = useAllObjects(props.connectionId, props.schema);
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

	const matching = objects.filter(
		(object) =>
			props.filter === "" ||
			`${object.schema}.${object.name}`.toLowerCase().includes(props.filter),
	);

	const byDomain = new Map<string, GroupedObject[]>();
	const untagged: GroupedObject[] = [];
	for (const object of matching) {
		if (object.domainId === null) {
			untagged.push(object);
			continue;
		}
		const list = byDomain.get(object.domainId) ?? [];
		list.push(object);
		byDomain.set(object.domainId, list);
	}

	const renderGroup = (
		id: string,
		label: string,
		colour: string | null,
		members: GroupedObject[],
		description?: string,
	) => {
		const open = collapsed[id] !== true;
		return (
			<div key={id}>
				<button
					type="button"
					className="dg-tree-row dg-domain-group"
					style={
						colour === null
							? undefined
							: ({ "--dg-domain-rail": colour } as React.CSSProperties)
					}
					aria-expanded={open}
					title={description}
					onClick={() =>
						setCollapsed({ ...collapsed, [id]: collapsed[id] !== true })
					}
				>
					<span className="dg-tree-label dg-domain-group-label">
						<span className="dg-tree-glyph">{open ? "▾" : "▸"}</span>
						{label}
					</span>
					<span className="dg-tree-count">{members.length}</span>
				</button>
				{open &&
					members.map((object) => (
						<ObjectRow
							key={domainTargetKey(object)}
							object={object}
							colour={colour}
							depth={1}
							connectionId={props.connectionId}
						/>
					))}
				{open && members.length === 0 && (
					<div
						className="dg-tree-note dg-tree-note-empty"
						style={{ paddingLeft: 24 }}
					>
						{loading ? "loading…" : "nothing tagged"}
					</div>
				)}
			</div>
		);
	};

	return (
		<div className="dg-domain-groups" role="tree">
			{domains.map((domain: Domain) =>
				renderGroup(
					domain.id,
					domain.name,
					domainColourVar(domain.colour),
					byDomain.get(domain.id) ?? [],
					domain.description === "" ? undefined : domain.description,
				),
			)}
			{/* Always present, always last, counted even at zero: this is the
			    drift the scripts could never show. */}
			{renderGroup("__untagged", "untagged", null, untagged)}
		</div>
	);
}
