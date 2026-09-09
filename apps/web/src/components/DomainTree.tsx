import type {
	DomainTarget,
	ObjectKind,
	SchemaPathSegment,
} from "@datagripe/contracts";
import { domainTargetKey } from "@datagripe/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { openObjectView, openTableView } from "../app/viewPanels";
import {
	domainColourVar,
	selectDomains,
	selectTags,
	useDomainsStore,
} from "../stores/domains";
import { nodeKey, useExplorerStore } from "../stores/runtime";
import { useTreeUi } from "../stores/treeUi";
import type { DomainGroup, GroupedObject } from "./domainGrouping";
import {
	DOMAIN_DRAG_MIME,
	decodeDragPayload,
	domainIdForDrop,
	dragPayload,
	dropChangesAnything,
	encodeDragPayload,
	groupByDomain,
	initiallyCollapsed,
	UNTAGGED_GROUP,
} from "./domainGrouping";
import { IconChevronDown, IconChevronRight, IconHidden } from "./icons";
import { TreeIcon } from "./treeIcons";
import { ContextMenu } from "./treeMenu";

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
 *
 * This is also the sorting surface: rows drag between groups, and the
 * arithmetic behind that lives in `domainGrouping.ts`.
 */

/** Tree categories that hold taggable objects, and the kind each yields. */
const CATEGORIES: Array<{ category: string; kind: ObjectKind }> = [
	{ category: "tables", kind: "table" },
	{ category: "views", kind: "view" },
	{ category: "functions", kind: "function" },
	{ category: "procedures", kind: "procedure" },
	{ category: "sequences", kind: "sequence" },
];

export type { GroupedObject } from "./domainGrouping";

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

type DropHandlers = {
	onDragOver: (event: React.DragEvent) => void;
	onDragLeave: (event: React.DragEvent) => void;
	onDrop: (event: React.DragEvent) => void;
};

function ObjectRow(props: {
	connectionId: string;
	object: GroupedObject;
	colour: string | null;
	depth: number;
	/** The owning group's drop zone. A row is part of it. */
	dropHandlers: DropHandlers;
}) {
	const target = {
		connectionId: props.connectionId,
		schema: props.object.schema,
		name: props.object.name,
		kind: props.object.kind,
	};
	const own: DomainTarget = {
		schema: props.object.schema,
		name: props.object.name,
		kind: props.object.kind,
	};
	const rowKey = domainTargetKey(own);
	const multiSelected = useTreeUi((state) => state.multiSelected);
	const toggleMulti = useTreeUi((state) => state.toggleMulti);
	const select = useTreeUi((state) => state.select);
	const selected = useTreeUi((state) => state.selectedKey === rowKey);
	const inMulti = multiSelected[rowKey] !== undefined;
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

	const open = () => {
		if (props.object.kind === "table" || props.object.kind === "view") {
			openTableView(target);
		} else {
			openObjectView(target, "ddl");
		}
	};

	const classes = ["dg-tree-row", "dg-domain-object"];
	if (selected) {
		classes.push("dg-tree-row-selected");
	}
	if (inMulti) {
		classes.push("dg-tree-row-multi");
	}

	return (
		<>
			<div
				{...props.dropHandlers}
				className={classes.join(" ")}
				style={{
					paddingLeft: 10 + props.depth * 14,
					...(props.colour === null
						? {}
						: ({ "--dg-domain-rail": props.colour } as React.CSSProperties)),
				}}
				role="treeitem"
				aria-selected={selected}
				tabIndex={0}
				// Ctrl/Cmd click builds the batch, exactly as in the schema
				// tree: sorting a hundred objects out of `untagged` one drag at
				// a time is not sorting, it is data entry.
				draggable={true}
				onDragStart={(event) => {
					const payload = dragPayload(rowKey, own, multiSelected);
					event.dataTransfer.setData(
						DOMAIN_DRAG_MIME,
						encodeDragPayload(payload),
					);
					event.dataTransfer.effectAllowed = "move";
				}}
				onClick={(event) => {
					if (event.ctrlKey || event.metaKey) {
						toggleMulti(rowKey, own);
						return;
					}
					select(rowKey);
				}}
				onDoubleClick={open}
				// Drag is mouse-only by nature, so the keyboard path to the
				// same edit is the context menu's `domain` submenu, reached
				// with the menu key on the focused row.
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						select(rowKey);
						open();
					}
				}}
				onContextMenu={(event) => {
					event.preventDefault();
					setMenu({ x: event.clientX, y: event.clientY });
				}}
			>
				<span className="dg-tree-label">
					<span className="dg-tree-glyph">
						<TreeIcon kind={props.object.kind} />
					</span>
					{/* Schema-qualified: the point of a domain is that it crosses
					    namespaces, so an unqualified name here would be ambiguous. */}
					<span className="dg-domain-qualified">{props.object.schema}.</span>
					{props.object.name}
				</span>
			</div>
			{menu !== null && (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					target={target}
					onClose={() => setMenu(null)}
				/>
			)}
		</>
	);
}

function Group(props: {
	connectionId: string;
	group: DomainGroup;
	open: boolean;
	loading: boolean;
	onToggle: () => void;
}) {
	const { group } = props;
	const tag = useDomainsStore((state) => state.tag);
	const tags = useDomainsStore(selectTags(props.connectionId));
	const clearMulti = useTreeUi((state) => state.clearMulti);
	const [over, setOver] = useState(false);
	const zoneRef = useRef<HTMLDivElement | null>(null);
	const colour = group.colour === null ? null : domainColourVar(group.colour);
	const destination = domainIdForDrop(group.id);

	const accept = (event: React.DragEvent): DomainTarget[] | null => {
		const raw = event.dataTransfer.getData(DOMAIN_DRAG_MIME);
		if (raw === "") {
			return null;
		}
		return decodeDragPayload(raw);
	};

	/*
	 * The whole group accepts the drop, header and members alike: dropping
	 * onto a row inside `auth` obviously means "put it in auth", and
	 * demanding the header would be a precision test.
	 *
	 * Spread onto the header button and each member row rather than onto
	 * the wrapping div, because those two are already interactive
	 * elements. A div carrying drop handlers and no role is both a lint
	 * error and a fair description of the problem.
	 */
	const dropHandlers = {
		onDragOver: (event: React.DragEvent) => {
			// Only during a drag whose payload we can read: `dragover` also
			// fires for a file dragged in from the desktop.
			if (!event.dataTransfer.types.includes(DOMAIN_DRAG_MIME)) {
				return;
			}
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			setOver(true);
		},
		onDragLeave: (event: React.DragEvent) => {
			// Crossing from the header onto a member row is one `dragleave`
			// and one `dragover` on two different elements that share this
			// state. Without the containment check the highlight flickers all
			// the way down a long group.
			const next = event.relatedTarget;
			if (next instanceof Node && zoneRef.current?.contains(next) === true) {
				return;
			}
			setOver(false);
		},
		onDrop: (event: React.DragEvent) => {
			event.preventDefault();
			setOver(false);
			const targets = accept(event);
			if (targets === null) {
				return;
			}
			// A drop that changes nothing writes nothing: re-tagging an
			// object into the domain it is already in would still be a round
			// trip and a fresh `tagged_by`.
			if (!dropChangesAnything(targets, tags, destination)) {
				return;
			}
			clearMulti();
			void tag(props.connectionId, targets, destination);
		},
	};

	return (
		<div
			ref={zoneRef}
			className={
				over ? "dg-domain-group-zone dg-domain-drop" : "dg-domain-group-zone"
			}
		>
			<button
				{...dropHandlers}
				type="button"
				className={
					group.hidden
						? "dg-tree-row dg-domain-group dg-domain-group-hidden"
						: "dg-tree-row dg-domain-group"
				}
				style={
					colour === null
						? undefined
						: ({ "--dg-domain-rail": colour } as React.CSSProperties)
				}
				aria-expanded={props.open}
				title={
					group.hidden
						? `${group.description === "" ? group.name : group.description} — hidden: kept out of the schema tree and out of the export`
						: group.description === ""
							? undefined
							: group.description
				}
				onClick={props.onToggle}
			>
				<span className="dg-tree-label dg-domain-group-label">
					<span className="dg-tree-glyph">
						{props.open ? <IconChevronDown /> : <IconChevronRight />}
					</span>
					{group.name}
					{group.hidden && (
						<IconHidden
							className="dg-domain-shelf-mark"
							aria-hidden={false}
							role="img"
							aria-label="hidden"
						/>
					)}
				</span>
				<span className="dg-tree-count">{group.members.length}</span>
			</button>
			{props.open &&
				group.members.map((object) => (
					<ObjectRow
						key={domainTargetKey(object)}
						object={object}
						colour={colour}
						depth={1}
						connectionId={props.connectionId}
						dropHandlers={dropHandlers}
					/>
				))}
			{props.open && group.members.length === 0 && (
				<div
					className="dg-tree-note dg-tree-note-empty"
					style={{ paddingLeft: 24 }}
				>
					{props.loading ? "loading…" : "nothing tagged"}
				</div>
			)}
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
	const [seeded, setSeeded] = useState(false);

	// Shelves start closed (docs/spec/domains.md "Hidden domains"). Seeded
	// once the domains have arrived rather than on every change, so
	// reopening one does not get undone by the next tag.
	useEffect(() => {
		if (seeded || domains.length === 0) {
			return;
		}
		setCollapsed(initiallyCollapsed(domains));
		setSeeded(true);
	}, [domains, seeded]);

	const matching = objects.filter(
		(object) =>
			props.filter === "" ||
			`${object.schema}.${object.name}`.toLowerCase().includes(props.filter),
	);
	const groups = groupByDomain(domains, matching);

	return (
		<div className="dg-domain-groups" role="tree">
			{groups.map((group) => (
				<Group
					key={group.id}
					connectionId={props.connectionId}
					group={group}
					loading={loading}
					open={collapsed[group.id] !== true}
					onToggle={() =>
						setCollapsed({
							...collapsed,
							[group.id]: collapsed[group.id] !== true,
						})
					}
				/>
			))}
			{groups.length === 1 && groups[0]?.id === UNTAGGED_GROUP && (
				<div className="dg-tree-note">no domains yet</div>
			)}
		</div>
	);
}
