import type {
	ConnectionMetadata,
	SchemaNode,
	SchemaPathSegment,
} from "@datagripe/contracts";
import {
	nodeKey,
	useConnectionsStore,
	useExplorerStore,
} from "../stores/runtime";

/**
 * Lazy schema explorer (docs/initial_idea.md §11):
 * connection → schema → tables/views → table/view → columns.
 * Children load on first expand; refresh re-requests expanded paths and
 * bypasses the server cache.
 */

const KIND_GLYPHS: Record<SchemaNode["kind"], string> = {
	schema: "◈",
	tables: "≡",
	views: "◉",
	table: "▦",
	view: "◍",
	column: "·",
	db: "⛁",
	prefix: "▸",
	key: "⚿",
};

function NodeRows(props: {
	connectionId: string;
	parentPath: SchemaPathSegment[];
	depth: number;
}) {
	const key = nodeKey(props.connectionId, props.parentPath);
	const children = useExplorerStore((state) => state.children[key]);

	if (children === undefined || children.status === "loading") {
		return (
			<div className="dg-tree-note" style={{ paddingLeft: props.depth * 14 }}>
				Loading…
			</div>
		);
	}
	if (children.status === "error") {
		return (
			<div
				className="dg-tree-note dg-tree-error"
				style={{ paddingLeft: props.depth * 14 }}
			>
				{children.message}
			</div>
		);
	}
	if (children.nodes.length === 0) {
		return (
			<div className="dg-tree-note" style={{ paddingLeft: props.depth * 14 }}>
				empty
			</div>
		);
	}
	return (
		<>
			{children.nodes.map((node) => (
				<TreeNode
					key={`${node.kind}:${node.name}`}
					connectionId={props.connectionId}
					parentPath={props.parentPath}
					node={node}
					depth={props.depth}
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
			<div className="dg-tree-note" style={{ paddingLeft: props.depth * 14 }}>
				Loading…
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div
				className="dg-tree-note dg-tree-error"
				style={{ paddingLeft: props.depth * 14 }}
			>
				{state.message}
			</div>
		);
	}
	const { value } = state;
	return (
		<div className="dg-kv" style={{ paddingLeft: props.depth * 14 }}>
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
	const toggle = useExplorerStore((state) => state.toggle);
	const toggleKeyValue = useExplorerStore((state) => state.toggleKeyValue);

	if (props.node.kind === "key") {
		// Redis key = path segments after the db node, joined by ":".
		const redisKey = path
			.slice(1)
			.map((s) => s.name)
			.join(":");
		return (
			<>
				<div className="dg-tree-row" style={{ paddingLeft: props.depth * 14 }}>
					<button
						type="button"
						className="dg-tree-chevron"
						aria-label={expanded ? "Hide value" : "Show value"}
						aria-expanded={expanded}
						onClick={() =>
							void toggleKeyValue(props.connectionId, path, redisKey)
						}
					>
						{expanded ? "▾" : "▸"}
					</button>
					<span className="dg-tree-label">
						<span className="dg-tree-glyph">
							{KIND_GLYPHS[props.node.kind]}
						</span>
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
			<div className="dg-tree-row" style={{ paddingLeft: props.depth * 14 }}>
				{props.node.hasChildren ? (
					<button
						type="button"
						className="dg-tree-chevron"
						aria-label={expanded ? "Collapse" : "Expand"}
						onClick={() => void toggle(props.connectionId, path)}
					>
						{expanded ? "▾" : "▸"}
					</button>
				) : (
					<span className="dg-tree-chevron dg-tree-leaf" />
				)}
				<span className="dg-tree-label">
					<span className="dg-tree-glyph">{KIND_GLYPHS[props.node.kind]}</span>
					{props.node.name}
					{props.node.kind === "column" &&
						props.node.dataType !== undefined && (
							<span className="dg-tree-type">
								{` ${props.node.dataType}${props.node.nullable === false ? " not null" : ""}`}
							</span>
						)}
				</span>
			</div>
			{expanded && (
				<NodeRows
					connectionId={props.connectionId}
					parentPath={path}
					depth={props.depth + 1}
				/>
			)}
		</>
	);
}

function ConnectionRow(props: { connection: ConnectionMetadata }) {
	const { connection } = props;
	const key = nodeKey(connection.id, []);
	const expanded = useExplorerStore(
		(state) => state.expanded[key] !== undefined,
	);
	const explorer = useExplorerStore.getState();
	const connections = useConnectionsStore.getState();

	return (
		<>
			<div className="dg-tree-row dg-tree-connection">
				<button
					type="button"
					className="dg-tree-chevron"
					aria-label={expanded ? "Collapse" : "Expand"}
					onClick={() => void explorer.toggle(connection.id, [])}
				>
					{expanded ? "▾" : "▸"}
				</button>
				<span className="dg-tree-label">
					<span className="dg-tree-glyph">⛁</span>
					{connection.name}
					{connection.source === "predefined" && (
						<span className="dg-badge">predefined</span>
					)}
				</span>
				<span className="dg-tree-actions">
					<button
						type="button"
						title="Refresh"
						aria-label={`Refresh ${connection.name}`}
						onClick={() => void explorer.refresh(connection.id)}
					>
						⟳
					</button>
					<button
						type="button"
						title={connection.source === "predefined" ? "View" : "Edit"}
						aria-label={`${connection.source === "predefined" ? "View" : "Edit"} ${connection.name}`}
						onClick={() => connections.openEditDialog(connection)}
					>
						✎
					</button>
					{connection.source === "managed" && (
						<button
							type="button"
							title="Delete"
							aria-label={`Delete ${connection.name}`}
							onClick={() => {
								if (window.confirm(`Delete connection "${connection.name}"?`)) {
									void connections.remove(connection.id);
								}
							}}
						>
							×
						</button>
					)}
				</span>
			</div>
			{expanded && (
				<NodeRows connectionId={connection.id} parentPath={[]} depth={1} />
			)}
		</>
	);
}

export function Explorer() {
	const connections = useConnectionsStore((state) => state.connections);
	const loaded = useConnectionsStore((state) => state.loaded);
	const openCreateDialog = useConnectionsStore(
		(state) => state.openCreateDialog,
	);

	return (
		<div className="dg-explorer">
			<div className="dg-sidebar-heading">
				Connections
				<button
					type="button"
					className="dg-heading-action"
					title="New connection"
					onClick={openCreateDialog}
				>
					+
				</button>
			</div>
			{!loaded && <div className="dg-tree-note">Connecting…</div>}
			{loaded && connections.length === 0 && (
				<div className="dg-tree-note">No connections yet.</div>
			)}
			{connections.map((connection) => (
				<ConnectionRow key={connection.id} connection={connection} />
			))}
		</div>
	);
}
