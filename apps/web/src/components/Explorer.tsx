import type {
	ObjectKind,
	SchemaNode,
	SchemaPathSegment,
} from "@datagripe/contracts";
import { isRelationKind, tabsForKind } from "@datagripe/contracts";
import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { create } from "zustand";
import {
	type ObjectTarget,
	openObjectView,
	openTableView,
} from "../app/viewPanels";
import { useDatasourceStore } from "../stores/datasource";
import {
	type ChildrenState,
	nodeKey,
	useConnectionsStore,
	useExplorerStore,
} from "../stores/runtime";
import { DatasourceBreadcrumb, treeRootPath } from "./DatasourceBreadcrumb";

/**
 * Schema tree scoped to the breadcrumb's datasource + namespace
 * (docs/brand/mocks/datasource-selector.html). No chevron gutter: the
 * type icon swaps to a chevron on hover/focus and the whole row toggles.
 * The filter shows loaded objects whose name matches. Hovering a table
 * or view for 450ms opens the field popover — a singleton, so a new one
 * replaces the last rather than stacking.
 */

/** Brand tree colouring: categories carry the accent, leaves stay
 * neutral so a wide schema does not turn into confetti. */
const KIND_COLORS: Record<SchemaNode["kind"], string> = {
	schema: "#5EEAD4",
	tables: "#8B5CF6",
	views: "#FF3EA5",
	functions: "#5EEAD4",
	procedures: "#5EEAD4",
	sequences: "#5EEAD4",
	table: "#9AA5B6",
	view: "#9AA5B6",
	function: "#9AA5B6",
	procedure: "#9AA5B6",
	sequence: "#9AA5B6",
	column: "#3D4759",
	db: "#9AA5B6",
	prefix: "#8B5CF6",
	key: "#A78BFA",
};

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
	popoverKey: string | null;
	select: (key: string | null) => void;
	openPopover: (key: string) => void;
	closePopover: () => void;
}

const useTreeUi = create<TreeUiState>()((set) => ({
	selectedKey: null,
	popoverKey: null,
	select: (key) => set({ selectedKey: key }),
	openPopover: (key) => set({ popoverKey: key }),
	closePopover: () => set({ popoverKey: null }),
}));

function CylinderIcon({ color }: { color: string }) {
	return (
		<>
			<path
				d="M8 2.5c-3.04 0-5.5.9-5.5 2v7c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2v-7c0-1.1-2.46-2-5.5-2Z"
				fill={color}
				fillOpacity="0.25"
				stroke={color}
				strokeWidth="1.2"
			/>
			<path
				d="M2.5 8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2"
				fill="none"
				stroke={color}
				strokeWidth="1.2"
			/>
		</>
	);
}

function FolderIcon({ color }: { color: string }) {
	return (
		<path
			d="M2 4.8c0-.9.7-1.6 1.6-1.6h2.9l1.4 1.7h4.5c.9 0 1.6.7 1.6 1.6v4.9c0 .9-.7 1.6-1.6 1.6H3.6c-.9 0-1.6-.7-1.6-1.6Z"
			fill={color}
			fillOpacity="0.2"
			stroke={color}
			strokeWidth="1.2"
		/>
	);
}

function TableIcon({ color }: { color: string }) {
	return (
		<>
			<rect
				x="2"
				y="3"
				width="12"
				height="10"
				rx="1.5"
				fill={color}
				fillOpacity="0.2"
				stroke={color}
				strokeWidth="1.2"
			/>
			<path
				d="M2 6.3h12M2 9.6h12M7 3v10"
				fill="none"
				stroke={color}
				strokeWidth="1.2"
			/>
		</>
	);
}

function ViewIcon({ color }: { color: string }) {
	return (
		<>
			<path
				d="M1.8 8S4 4.2 8 4.2 14.2 8 14.2 8 12 11.8 8 11.8 1.8 8 1.8 8Z"
				fill={color}
				fillOpacity="0.15"
				stroke={color}
				strokeWidth="1.2"
			/>
			<circle cx="8" cy="8" r="1.8" fill={color} />
		</>
	);
}

function TextIcon({ color, text }: { color: string; text: string }) {
	return (
		<text
			x="8"
			y="12"
			textAnchor="middle"
			fontSize="9"
			fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
			fontWeight="700"
			fill={color}
		>
			{text}
		</text>
	);
}

function SequenceIcon({ color }: { color: string }) {
	return (
		<path
			d="M2 4h3.5M2 8h3.5M2 12h3.5M8.5 4H14M8.5 8H14M8.5 12H14"
			fill="none"
			stroke={color}
			strokeWidth="1.4"
			strokeLinecap="round"
		/>
	);
}

function ColumnIcon({ color }: { color: string }) {
	return (
		<path
			d="M4.5 3.5v9M8 3.5v6M11.5 3.5v3"
			fill="none"
			stroke={color}
			strokeWidth="1.4"
			strokeLinecap="round"
		/>
	);
}

function KeyIcon({ color }: { color: string }) {
	return (
		<>
			<circle
				cx="5"
				cy="5.5"
				r="2.5"
				fill="none"
				stroke={color}
				strokeWidth="1.3"
			/>
			<path
				d="M6.8 7.3 13 13.5M10.5 10.5l2-2M12.5 12.5l1.5-1.5"
				fill="none"
				stroke={color}
				strokeWidth="1.3"
				strokeLinecap="round"
			/>
		</>
	);
}

function TreeIcon(props: { kind: SchemaNode["kind"]; color?: string }) {
	const color = props.color ?? KIND_COLORS[props.kind];
	let body: ReactNode;
	switch (props.kind) {
		case "db":
		case "schema":
			body = <CylinderIcon color={color} />;
			break;
		case "tables":
		case "views":
		case "functions":
		case "procedures":
		case "sequences":
		case "prefix":
			body = <FolderIcon color={color} />;
			break;
		case "table":
			body = <TableIcon color={color} />;
			break;
		case "view":
			body = <ViewIcon color={color} />;
			break;
		case "function":
			body = <TextIcon color={color} text="fx" />;
			break;
		case "procedure":
			body = <TextIcon color={color} text="pr" />;
			break;
		case "sequence":
			body = <SequenceIcon color={color} />;
			break;
		case "key":
			body = <KeyIcon color={color} />;
			break;
		default:
			body = <ColumnIcon color={color} />;
	}
	return (
		<svg className="dg-tree-icon" viewBox="0 0 16 16" aria-hidden="true">
			{body}
		</svg>
	);
}

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
					{props.expanded ? "▾" : "▸"}
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

	const activate = () => {
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
				className={
					selected ? "dg-tree-row dg-tree-row-selected" : "dg-tree-row"
				}
				style={{ paddingLeft: 10 + props.depth * 14 }}
				role="treeitem"
				aria-selected={selected}
				aria-expanded={props.node.hasChildren ? showChildren : undefined}
				tabIndex={0}
				onClick={activate}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						activate();
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
							⊞
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
			</div>
			{!loaded && (
				<div className="dg-tree-note dg-tree-note-loading">connecting…</div>
			)}
			{loaded && connections.length === 0 && (
				<div className="dg-tree-note">
					no datasources — ＋ in the breadcrumb adds one
				</div>
			)}
			{loaded && active !== null && rootPath === null && (
				<div className="dg-tree-note dg-tree-note-loading">loading…</div>
			)}
			{active !== null && rootPath !== null && (
				<NodeRows
					connectionId={active.id}
					parentPath={rootPath}
					depth={0}
					filter={filter.trim().toLowerCase()}
				/>
			)}
		</div>
	);
}
