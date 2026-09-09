import type {
	DomainTarget,
	ObjectKind,
	SchemaNode,
	SchemaPathSegment,
} from "@datagripe/contracts";
import {
	domainTargetKey,
	isRelationKind,
	tabsForKind,
} from "@datagripe/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import {
	type ObjectTarget,
	openDomainManager,
	openObjectView,
	openTableView,
} from "../app/viewPanels";
import { useDatasourceStore } from "../stores/datasource";
import {
	domainColourVar,
	selectDomainId,
	selectDomains,
	useDomainsStore,
} from "../stores/domains";
import {
	type ChildrenState,
	nodeKey,
	useConnectionsStore,
	useExplorerStore,
} from "../stores/runtime";
import { DatasourceBreadcrumb, treeRootPath } from "./DatasourceBreadcrumb";
import { DomainGroups } from "./DomainTree";
import {
	IconAdd,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconDomains,
	IconMore,
	IconObject,
} from "./icons";
import { KIND_COLORS, TreeIcon } from "./treeIcons";

/**
 * Schema tree scoped to the breadcrumb's datasource + namespace
 * (docs/brand/mocks/datasource-selector.html). No chevron gutter: the
 * type icon swaps to a chevron on hover/focus and the whole row toggles.
 * The filter shows loaded objects whose name matches. Hovering a table
 * or view for 450ms opens the field popover — a singleton, so a new one
 * replaces the last rather than stacking.
 */

const CATEGORY_KINDS: Partial<Record<SchemaNode["kind"], true>> = {
	tables: true,
	views: true,
	functions: true,
	procedures: true,
	sequences: true,
};

/**
 * Tree leaves that have an object view. Routines and sequences are here
 * too: a function's definition is the object, and PostgreSQL exports it
 * verbatim (docs/spec/object-view.md).
 */
const OBJECT_KINDS: Partial<Record<SchemaNode["kind"], true>> = {
	table: true,
	view: true,
	function: true,
	procedure: true,
	sequence: true,
};

/** Kinds that have rows, and so a table view. */
const RELATION_KINDS: Partial<Record<SchemaNode["kind"], true>> = {
	table: true,
	view: true,
};

/** Synthetic empty-row label per category (brand-system.md "Chevrons"). */
const EMPTY_LABELS: Partial<Record<SchemaNode["kind"], string>> = {
	tables: "no tables",
	views: "no views",
	functions: "no functions",
	procedures: "no procedures",
	sequences: "no sequences",
};

/** Single-row selection plus the singleton field popover, shared across
 * the recursive tree. Opening a popover replaces whichever was open. */
interface TreeUiState {
	selectedKey: string | null;
	/**
	 * Ctrl/Cmd-click adds to this. It is the bulk-tagging path: filter the
	 * tree, select the matches, tag once — the thing that makes tagging
	 * two hundred objects survivable (docs/spec/domains.md "Context menu").
	 */
	multiSelected: Record<string, DomainTarget>;
	popoverKey: string | null;
	select: (key: string | null) => void;
	toggleMulti: (key: string, target: DomainTarget) => void;
	clearMulti: () => void;
	openPopover: (key: string) => void;
	closePopover: () => void;
}

const useTreeUi = create<TreeUiState>()((set, get) => ({
	selectedKey: null,
	multiSelected: {},
	popoverKey: null,
	// A plain click collapses the multi-selection: leaving it live after
	// you have obviously moved on is how a bulk action hits the wrong
	// two hundred objects.
	select: (key) => set({ selectedKey: key, multiSelected: {} }),
	toggleMulti: (key, target) => {
		const { [key]: existing, ...rest } = get().multiSelected;
		set({
			selectedKey: key,
			multiSelected: existing === undefined ? { ...rest, [key]: target } : rest,
		});
	},
	clearMulti: () => set({ multiSelected: {} }),
	openPopover: (key) => set({ popoverKey: key }),
	closePopover: () => set({ popoverKey: null }),
}));

/**
 * The type icon swaps to a chevron on hover and keyboard focus
 * (brand-system.md "Chevrons") — content visibility is the state signal,
 * so no permanent gutter column is spent on it.
 */
function TreeGlyph(props: {
	kind: SchemaNode["kind"];
	hasChildren: boolean;
	expanded: boolean;
}) {
	return (
		<span
			className={`dg-tree-glyph${props.hasChildren ? " dg-tree-glyph-parent" : ""}`}
		>
			<TreeIcon kind={props.kind} />
			{props.hasChildren && (
				<span className="dg-tree-glyph-chev" aria-hidden="true">
					{props.expanded ? <IconChevronDown /> : <IconChevronRight />}
				</span>
			)}
		</span>
	);
}

/**
 * Composite column glyph for the field popover: base bars carry the
 * column, overlays stack state without growing the row — hollow ring =
 * nullable, filled dot = not null, magenta key tooth = primary key, cyan
 * tick = indexed. The schema contract currently ships nullability only;
 * key and index parts layer in once the contract exposes them.
 */
function ColumnGlyph(props: {
	nullable: boolean | undefined;
	primaryKey?: boolean;
	indexed?: boolean;
}) {
	return (
		<svg className="dg-popover-glyph" viewBox="0 0 14 14" aria-hidden="true">
			<path
				d="M4 2.5v9M7.5 2.5v6"
				fill="none"
				stroke="var(--dg-ink-mute)"
				strokeWidth="1.3"
				strokeLinecap="round"
			/>
			{/* nullability: ring vs filled dot, shape + colour cue */}
			{props.nullable === false ? (
				<circle cx="11" cy="11" r="2" fill="var(--dg-cyan)" />
			) : (
				<circle
					cx="11"
					cy="11"
					r="2"
					fill="none"
					stroke="var(--dg-ink-faint)"
					strokeWidth="1.1"
				/>
			)}
			{props.primaryKey === true && (
				<path
					d="M9.5 4.5 13 .5M11.5 2.5l1.4 1.4"
					fill="none"
					stroke="var(--dg-magenta)"
					strokeWidth="1.3"
					strokeLinecap="round"
				/>
			)}
			{props.indexed === true && (
				<path
					d="M1 12.5 4.5 9"
					fill="none"
					stroke="var(--dg-cyan)"
					strokeWidth="1.3"
					strokeLinecap="round"
				/>
			)}
		</svg>
	);
}

/* ---- field popover (singleton) -------------------------------------
 * Hover a table or view for 450ms: columns to the right. Dismisses on
 * mouseleave, Escape and mousedown (so it never fights a drag), and is
 * replaced — never stacked — when another row's delay elapses.
 * Suppressed while a context menu is open.
 */

const POPOVER_DELAY_MS = 450;

function FieldPopover(props: {
	connectionId: string;
	path: SchemaPathSegment[];
	name: string;
	anchor: DOMRect;
	onClose: () => void;
}) {
	const children = useExplorerStore(
		(state) => state.children[nodeKey(props.connectionId, props.path)],
	);
	const ref = useRef<HTMLDivElement | null>(null);
	const [top, setTop] = useState(props.anchor.top);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				props.onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("mousedown", props.onClose);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("mousedown", props.onClose);
		};
	}, [props.onClose]);

	// Reposition upward when the popover would overflow the pane bottom.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when column content arrives, since offsetHeight grows
	useLayoutEffect(() => {
		const popover = ref.current;
		if (popover !== null) {
			const overflow =
				props.anchor.top + popover.offsetHeight - window.innerHeight + 8;
			if (overflow > 0) {
				setTop(Math.max(8, props.anchor.top - overflow));
			}
		}
	}, [props.anchor.top, children]);

	return (
		<div
			ref={ref}
			className="dg-popover dg-scroll"
			role="tooltip"
			style={{ top, left: props.anchor.right + 8 }}
			onMouseLeave={props.onClose}
		>
			<div className="dg-popover-title">{props.name}</div>
			{children === undefined || children.status === "loading" ? (
				<div className="dg-popover-note">loading…</div>
			) : children.status === "error" ? (
				<div className="dg-popover-note">{children.message}</div>
			) : (
				children.nodes
					.filter((node) => node.kind === "column")
					.map((column) => (
						<div key={column.name} className="dg-popover-row">
							<ColumnGlyph nullable={column.nullable} />
							<span className="dg-popover-col">{column.name}</span>
							<span className="dg-popover-type">{column.dataType ?? ""}</span>
						</div>
					))
			)}
		</div>
	);
}

/* ---- context menu ----------------------------------------------------
 * Structural entries deep-link into the object view (brand-system.md
 * "Context menu").
 */

/** Narrow a tree node kind to the object kinds the object view takes. */
function objectKindOf(kind: SchemaNode["kind"]): ObjectKind {
	switch (kind) {
		case "view":
		case "function":
		case "procedure":
		case "sequence":
			return kind;
		default:
			return "table";
	}
}

/**
 * The `domain ▸` submenu (docs/spec/domains.md "Context menu").
 *
 * Each item carries its own colour rail and a check on the current
 * domain. `untag` appears only when the object is tagged, because an
 * item that does nothing is worse than no item.
 */
function DomainSubmenu(props: {
	connectionRef: string;
	target: ObjectTarget;
	onClose: () => void;
}) {
	const domains = useDomainsStore(selectDomains(props.connectionRef));
	const currentId = useDomainsStore(
		(state) =>
			state.tagsByConnection[props.connectionRef]?.[
				domainTargetKey({
					schema: props.target.schema,
					name: props.target.name,
					kind: props.target.kind,
				})
			] ?? null,
	);
	const tag = useDomainsStore((state) => state.tag);
	const multiSelected = useTreeUi((state) => state.multiSelected);
	const clearMulti = useTreeUi((state) => state.clearMulti);
	const [open, setOpen] = useState(false);

	const own: DomainTarget = {
		schema: props.target.schema,
		name: props.target.name,
		kind: props.target.kind,
	};
	// With a multi-selection live the submenu applies to all of it. The
	// right-clicked row joins in even if it was not part of the selection,
	// because it is what the pointer is on.
	const selection = Object.values(multiSelected);
	const targets =
		selection.length === 0
			? [own]
			: selection.some(
						(entry) => domainTargetKey(entry) === domainTargetKey(own),
					)
				? selection
				: [...selection, own];

	const assign = (domainId: string | null) => {
		props.onClose();
		clearMulti();
		void tag(props.connectionRef, targets, domainId);
	};

	return (
		<div
			className="dg-context-sub"
			role="none"
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
		>
			<button
				type="button"
				className="dg-context-item"
				role="menuitem"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				{targets.length > 1 ? `domain (${targets.length} objects)` : "domain"}{" "}
				<span className="dg-context-chevron">
					<IconChevronRight />
				</span>
			</button>
			{open && (
				<div className="dg-context-menu dg-context-submenu" role="menu">
					{domains.length === 0 && (
						<div className="dg-context-note">no domains yet</div>
					)}
					{domains.map((domain) => (
						<button
							key={domain.id}
							type="button"
							className="dg-context-item dg-context-domain"
							role="menuitemradio"
							aria-checked={targets.length === 1 && domain.id === currentId}
							style={
								{
									"--dg-domain-rail": domainColourVar(domain.colour),
								} as React.CSSProperties
							}
							onClick={() => assign(domain.id)}
						>
							{domain.name}
							{/* Mixed current domains show no check: a tick that only
							    described one of seven objects would be a lie. */}
							{targets.length === 1 && domain.id === currentId && <IconCheck />}
						</button>
					))}
					{(currentId !== null || targets.length > 1) && (
						<>
							<div className="dg-context-separator" />
							<button
								type="button"
								className="dg-context-item"
								role="menuitem"
								onClick={() => assign(null)}
							>
								untag
							</button>
						</>
					)}
					<div className="dg-context-separator" />
					<button
						type="button"
						className="dg-context-item"
						role="menuitem"
						onClick={() => {
							props.onClose();
							openDomainManager(props.connectionRef);
						}}
					>
						new domain…
					</button>
				</div>
			)}
		</div>
	);
}

function ContextMenu(props: {
	x: number;
	y: number;
	target: ObjectTarget;
	onClose: () => void;
}) {
	const relation = isRelationKind(props.target.kind);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				props.onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("mousedown", props.onClose);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("mousedown", props.onClose);
		};
	}, [props.onClose]);

	return (
		<div
			className="dg-context-menu"
			role="menu"
			style={{ top: props.y, left: props.x }}
			onMouseDown={(event) => event.stopPropagation()}
		>
			{relation && (
				<>
					<button
						type="button"
						className="dg-context-item"
						role="menuitem"
						onClick={() => {
							props.onClose();
							openTableView(props.target);
						}}
					>
						view rows <kbd>dbl click</kbd>
					</button>
					<div className="dg-context-separator" />
				</>
			)}
			{tabsForKind(props.target.kind).map((tab) => (
				<button
					key={tab}
					type="button"
					className="dg-context-item"
					role="menuitem"
					onClick={() => {
						props.onClose();
						openObjectView(props.target, tab);
					}}
				>
					{tab}
					{!relation && tab === "ddl" && <kbd>dbl click</kbd>}
				</button>
			))}
			<div className="dg-context-separator" />
			<DomainSubmenu
				connectionRef={props.target.connectionId}
				target={props.target}
				onClose={props.onClose}
			/>
			<button
				type="button"
				className="dg-context-item"
				role="menuitem"
				onClick={() => {
					props.onClose();
					void navigator.clipboard.writeText(props.target.name);
				}}
			>
				copy name
			</button>
			{relation && (
				<>
					<div className="dg-context-separator" />
					<button
						type="button"
						className="dg-context-item dg-context-danger"
						role="menuitem"
						onClick={() => {
							props.onClose();
							openObjectView(props.target, "danger");
						}}
					>
						danger zone…
					</button>
				</>
			)}
		</div>
	);
}

/* ---- filtering ------------------------------------------------------
 * "filter objects…" matches against loaded nodes by name. Categories
 * (and Redis prefixes) with matching loaded children open for the
 * duration of the filter without touching the expansion state.
 */

function nameMatches(name: string, filter: string): boolean {
	return name.toLowerCase().includes(filter);
}

/** True when the node or any loaded descendant matches the filter. */
function subtreeMatches(
	connectionId: string,
	path: SchemaPathSegment[],
	node: SchemaNode,
	filter: string,
	children: Record<string, ChildrenState>,
): boolean {
	if (nameMatches(node.name, filter)) {
		return true;
	}
	const nodePath = [...path, { kind: node.kind, name: node.name }];
	const state = children[nodeKey(connectionId, nodePath)];
	if (state?.status !== "loaded") {
		return false;
	}
	return state.nodes.some((child) =>
		subtreeMatches(connectionId, nodePath, child, filter, children),
	);
}

function NodeRows(props: {
	connectionId: string;
	parentPath: SchemaPathSegment[];
	depth: number;
	filter: string;
}) {
	const key = nodeKey(props.connectionId, props.parentPath);
	const children = useExplorerStore((state) => state.children[key]);
	const allChildren = useExplorerStore((state) => state.children);
	const filtering = props.filter.length > 0;

	if (children === undefined || children.status === "loading") {
		return (
			<div
				className="dg-tree-note dg-tree-note-loading"
				style={{ paddingLeft: 10 + props.depth * 14 }}
			>
				loading…
			</div>
		);
	}
	if (children.status === "error") {
		return (
			<div
				className="dg-tree-note dg-tree-error"
				style={{ paddingLeft: 10 + props.depth * 14 }}
			>
				{children.message}
			</div>
		);
	}
	const visible = filtering
		? children.nodes.filter((node) =>
				subtreeMatches(
					props.connectionId,
					props.parentPath,
					node,
					props.filter,
					allChildren,
				),
			)
		: children.nodes;
	if (visible.length === 0) {
		if (filtering) {
			return null;
		}
		const parentKind = props.parentPath[props.parentPath.length - 1]?.kind;
		return (
			<div
				className="dg-tree-note"
				style={{ paddingLeft: 10 + props.depth * 14 }}
			>
				{(parentKind !== undefined && EMPTY_LABELS[parentKind]) || "empty"}
			</div>
		);
	}
	return (
		<>
			{visible.map((node) => (
				<TreeNode
					key={`${node.kind}:${node.name}`}
					connectionId={props.connectionId}
					parentPath={props.parentPath}
					node={node}
					depth={props.depth}
					filter={props.filter}
				/>
			))}
		</>
	);
}

function KeyValueView(props: {
	connectionId: string;
	path: SchemaPathSegment[];
	depth: number;
}) {
	const key = nodeKey(props.connectionId, props.path);
	const state = useExplorerStore((s) => s.keyValues[key]);

	if (state === undefined || state.status === "loading") {
		return (
			<div
				className="dg-tree-note dg-tree-note-loading"
				style={{ paddingLeft: 10 + props.depth * 14 }}
			>
				loading…
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div
				className="dg-tree-note dg-tree-error"
				style={{ paddingLeft: 10 + props.depth * 14 }}
			>
				{state.message}
			</div>
		);
	}
	const { value } = state;
	return (
		<div className="dg-kv" style={{ paddingLeft: 10 + props.depth * 14 }}>
			<div className="dg-kv-meta">
				{value.type}
				{value.ttlSeconds >= 0 ? ` · ttl ${value.ttlSeconds}s` : " · no expiry"}
				{value.truncated ? " · truncated" : ""}
			</div>
			{value.entries.map((entry, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: value entries have no stable identity
				<div key={index} className="dg-kv-entry">
					{entry.field !== undefined && (
						<span className="dg-kv-field">{entry.field}</span>
					)}
					<span className="dg-kv-value">{entry.value}</span>
				</div>
			))}
		</div>
	);
}

function TreeNode(props: {
	connectionId: string;
	parentPath: SchemaPathSegment[];
	node: SchemaNode;
	depth: number;
	filter: string;
}) {
	const segment: SchemaPathSegment = {
		kind: props.node.kind,
		name: props.node.name,
	};
	const path = [...props.parentPath, segment];
	const key = nodeKey(props.connectionId, path);
	const expanded = useExplorerStore(
		(state) => state.expanded[key] !== undefined,
	);
	const children = useExplorerStore((state) => state.children[key]);
	const toggle = useExplorerStore((state) => state.toggle);
	const toggleKeyValue = useExplorerStore((state) => state.toggleKeyValue);
	const ensure = useExplorerStore((state) => state.ensure);
	const selected = useTreeUi((state) => state.selectedKey === key);
	const popoverOpen = useTreeUi((state) => state.popoverKey === key);
	const select = useTreeUi((state) => state.select);
	const toggleMulti = useTreeUi((state) => state.toggleMulti);
	const multiSelected = useTreeUi((state) => state.multiSelected);
	const inMulti = multiSelected[key] !== undefined;
	const openPopover = useTreeUi((state) => state.openPopover);
	const closePopover = useTreeUi((state) => state.closePopover);

	const isObject = OBJECT_KINDS[props.node.kind] === true;
	const isCategory = CATEGORY_KINDS[props.node.kind] === true;
	// Objects always hang under their namespace, whether that came from
	// the breadcrumb (`[schema]` root) or from an expanded schema row.
	const isRelation = RELATION_KINDS[props.node.kind] === true;
	const objectTarget: ObjectTarget = {
		connectionId: props.connectionId,
		schema: path[0]?.name ?? "",
		name: props.node.name,
		kind: objectKindOf(props.node.kind),
	};
	/** Rows for a relation; the definition for everything else. */
	const openPrimaryView = () => {
		if (isRelation) {
			openTableView(objectTarget);
		} else {
			openObjectView(objectTarget, "ddl");
		}
	};
	const filtering = props.filter.length > 0;
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const rowRef = useRef<HTMLDivElement | null>(null);
	// The rail stays on in the normal, schema-first mode too: it is what
	// makes a mis-tagged table visible without switching views.
	//
	// Two stable selectors joined in render, rather than one selector
	// building `{ colour, name }`: a selector that returns a fresh object
	// every call is a new snapshot every render, and React loops on it.
	const targetKey = domainTargetKey({
		schema: objectTarget.schema,
		name: objectTarget.name,
		kind: objectTarget.kind,
	});
	const taggedDomainId = useDomainsStore(
		selectDomainId(props.connectionId, targetKey),
	);
	const connectionDomains = useDomainsStore(selectDomains(props.connectionId));
	const railDomain =
		isObject && taggedDomainId !== null
			? (connectionDomains.find((entry) => entry.id === taggedDomainId) ?? null)
			: null;
	const railColour =
		railDomain === null
			? null
			: { colour: domainColourVar(railDomain.colour), name: railDomain.name };

	const clearHoverTimer = () => {
		clearTimeout(hoverTimer.current);
		hoverTimer.current = undefined;
	};

	useEffect(
		() => () => {
			clearTimeout(hoverTimer.current);
		},
		[],
	);

	// While filtering, categories self-load so their objects can match.
	// Schema/db levels do the same — with "show all schemas" a match can
	// live in any schema, not just the expanded ones.
	const selfLoads =
		isCategory || props.node.kind === "schema" || props.node.kind === "db";
	// biome-ignore lint/correctness/useExhaustiveDependencies: path is rebuilt per render; keyed on its stable string form instead
	useEffect(() => {
		if (filtering && selfLoads && children === undefined) {
			void ensure(props.connectionId, path);
		}
	}, [filtering, selfLoads, children, ensure, props.connectionId, key]);

	// In filter mode a node with matches opens for the duration without
	// touching the stored expansion state.
	const forceOpen =
		filtering &&
		children?.status === "loaded" &&
		children.nodes.some((child) => nameMatches(child.name, props.filter));
	const showChildren = props.node.hasChildren && (expanded || forceOpen);

	const objectHandlers = isObject
		? {
				onMouseEnter: () => {
					clearHoverTimer();
					hoverTimer.current = setTimeout(() => {
						// Suppressed while a context menu is open.
						if (menu === null && rowRef.current !== null) {
							void ensure(props.connectionId, path);
							setAnchor(rowRef.current.getBoundingClientRect());
							openPopover(key);
						}
					}, POPOVER_DELAY_MS);
				},
				onMouseLeave: () => {
					clearHoverTimer();
				},
				onMouseDown: (event: React.MouseEvent) => {
					// The popover must not fight drag-to-editor or middle click.
					clearHoverTimer();
					closePopover();
					if (event.button === 1) {
						event.preventDefault();
						openPrimaryView();
					}
				},
				onDoubleClick: openPrimaryView,
				onContextMenu: (event: React.MouseEvent) => {
					event.preventDefault();
					clearHoverTimer();
					closePopover();
					setMenu({ x: event.clientX, y: event.clientY });
				},
			}
		: {};

	const activate = (event?: React.MouseEvent | React.KeyboardEvent) => {
		// Ctrl/Cmd click adds to the multi-selection (objects only) and
		// never expands: the gesture is "also this one", not "open it".
		if (isObject && event !== undefined && (event.ctrlKey || event.metaKey)) {
			toggleMulti(key, {
				schema: objectTarget.schema,
				name: objectTarget.name,
				kind: objectTarget.kind,
			});
			return;
		}
		select(key);
		if (props.node.hasChildren) {
			void toggle(props.connectionId, path);
		}
	};

	if (props.node.kind === "key") {
		// Redis key = path segments after the db node, joined by ":".
		const redisKey = path
			.slice(1)
			.map((s) => s.name)
			.join(":");
		return (
			<>
				<div
					className={
						selected ? "dg-tree-row dg-tree-row-selected" : "dg-tree-row"
					}
					style={{ paddingLeft: 10 + props.depth * 14 }}
					role="treeitem"
					aria-selected={selected}
					tabIndex={0}
					onClick={() => {
						select(key);
						void toggleKeyValue(props.connectionId, path, redisKey);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							select(key);
							void toggleKeyValue(props.connectionId, path, redisKey);
						}
					}}
				>
					<span className="dg-tree-label">
						<TreeGlyph
							kind={props.node.kind}
							hasChildren={false}
							expanded={false}
						/>
						{props.node.name}
					</span>
				</div>
				{expanded && (
					<KeyValueView
						connectionId={props.connectionId}
						path={path}
						depth={props.depth + 1}
					/>
				)}
			</>
		);
	}

	return (
		<>
			<div
				ref={rowRef}
				className={[
					"dg-tree-row",
					selected ? "dg-tree-row-selected" : "",
					inMulti ? "dg-tree-row-multi" : "",
				]
					.filter((entry) => entry !== "")
					.join(" ")}
				style={{
					paddingLeft: 10 + props.depth * 14,
					...(railColour === null
						? {}
						: ({
								"--dg-domain-rail": railColour.colour,
							} as React.CSSProperties)),
				}}
				data-domain={railColour?.name}
				// Colour is never the only carrier: the domain is in the
				// accessible name as well as on the rail.
				title={railColour === null ? undefined : `domain: ${railColour.name}`}
				role="treeitem"
				aria-selected={selected}
				aria-expanded={props.node.hasChildren ? showChildren : undefined}
				tabIndex={0}
				onClick={activate}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						activate(event);
					}
				}}
				{...objectHandlers}
			>
				<span
					className={
						isCategory
							? "dg-tree-label dg-tree-label-category"
							: "dg-tree-label"
					}
					style={
						isCategory
							? ({
									"--dg-tree-accent": KIND_COLORS[props.node.kind],
								} as React.CSSProperties)
							: undefined
					}
				>
					<TreeGlyph
						kind={props.node.kind}
						hasChildren={props.node.hasChildren}
						expanded={showChildren}
					/>
					{props.node.name}
					{isCategory &&
						children !== undefined &&
						children.status === "loaded" && (
							<span className="dg-tree-count">{children.nodes.length}</span>
						)}
					{props.node.kind === "column" &&
						props.node.dataType !== undefined && (
							<span className="dg-tree-type">{` ${props.node.dataType}`}</span>
						)}
				</span>
				{isObject && (
					<span className="dg-tree-actions">
						<button
							type="button"
							title="Open object view"
							aria-label={`Open object view for ${props.node.name}`}
							onClick={(event) => {
								event.stopPropagation();
								openObjectView(objectTarget);
							}}
						>
							<IconObject />
						</button>
					</span>
				)}
			</div>
			{popoverOpen && anchor !== null && menu === null && (
				<FieldPopover
					connectionId={props.connectionId}
					path={path}
					name={props.node.name}
					anchor={anchor}
					onClose={closePopover}
				/>
			)}
			{menu !== null && (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					target={objectTarget}
					onClose={() => setMenu(null)}
				/>
			)}
			{showChildren && (
				<NodeRows
					connectionId={props.connectionId}
					parentPath={path}
					depth={props.depth + 1}
					filter={props.filter}
				/>
			)}
		</>
	);
}

export function Explorer() {
	const connections = useConnectionsStore((state) => state.connections);
	const loaded = useConnectionsStore((state) => state.loaded);
	const activeConnectionId = useDatasourceStore(
		(state) => state.activeConnectionId,
	);
	const namespaceByConnection = useDatasourceStore(
		(state) => state.namespaceByConnection,
	);
	const ensure = useExplorerStore((state) => state.ensure);
	const [filter, setFilter] = useState("");
	const grouped = useDomainsStore((state) => state.grouped);
	const setGrouped = useDomainsStore((state) => state.setGrouped);
	const loadDomains = useDomainsStore((state) => state.load);

	const active =
		connections.find((connection) => connection.id === activeConnectionId) ??
		null;
	const rootPath =
		active === null
			? null
			: treeRootPath(active, namespaceByConnection[active.id]);

	// The tree root hangs from the breadcrumb selection; load it when the
	// selection lands (this is also what connects a lazy datasource).
	const rootPathKey =
		active !== null && rootPath !== null ? nodeKey(active.id, rootPath) : null;
	const rootChildren = useExplorerStore((state) =>
		rootPathKey === null ? undefined : state.children[rootPathKey],
	);
	useEffect(() => {
		if (active !== null && rootPath !== null && rootChildren === undefined) {
			void ensure(active.id, rootPath);
		}
	}, [active, rootPath, rootChildren, ensure]);

	// Domains are per datasource, so they reload when the breadcrumb
	// moves. Loading them here rather than lazily in the rail keeps the
	// colour from appearing a beat after the row.
	useEffect(() => {
		if (active !== null) {
			void loadDomains(active.id);
		}
	}, [active, loadDomains]);

	return (
		<div className="dg-explorer dg-scroll">
			<DatasourceBreadcrumb />
			<div className="dg-tree-filter">
				<input
					placeholder="filter objects…"
					aria-label="Filter objects"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
				{/* A view mode, not a filter: every object stays reachable in
				    both, and expansion state is tracked per mode. */}
				<button
					type="button"
					className={
						grouped ? "dg-tree-group-on dg-tree-group" : "dg-tree-group"
					}
					aria-pressed={grouped}
					title="Group by domain"
					aria-label="Group by domain"
					onClick={() => setGrouped(!grouped)}
				>
					<IconDomains />
				</button>
				<button
					type="button"
					className="dg-tree-group"
					title="Manage domains"
					aria-label="Manage domains"
					disabled={active === null}
					onClick={() => active !== null && openDomainManager(active.id)}
				>
					<IconMore />
				</button>
			</div>
			{!loaded && (
				<div className="dg-tree-note dg-tree-note-loading">connecting…</div>
			)}
			{loaded && connections.length === 0 && (
				<div className="dg-tree-note">
					no datasources —{" "}
					<IconAdd aria-hidden={false} role="img" aria-label="the plus" /> in
					the breadcrumb adds one
				</div>
			)}
			{loaded && active !== null && rootPath === null && (
				<div className="dg-tree-note dg-tree-note-loading">loading…</div>
			)}
			{active !== null && rootPath !== null && !grouped && (
				<NodeRows
					connectionId={active.id}
					parentPath={rootPath}
					depth={0}
					filter={filter.trim().toLowerCase()}
				/>
			)}
			{active !== null && rootPath !== null && grouped && (
				<DomainGroups
					connectionId={active.id}
					schema={rootPath[0]?.name ?? ""}
					filter={filter.trim().toLowerCase()}
				/>
			)}
		</div>
	);
}
