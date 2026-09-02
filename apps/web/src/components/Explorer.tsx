import type {
	ConnectionAdapter,
	ConnectionMetadata,
	SchemaNode,
	SchemaPathSegment,
} from "@datagripe/contracts";
import type { ReactNode } from "react";
import {
	nodeKey,
	useConnectionsStore,
	useExplorerStore,
} from "../stores/runtime";

/**
 * Lazy schema explorer (docs/initial_idea.md §11):
 * connection → schema → tables/views/functions/… → object → columns.
 * Children load on first expand; refresh re-requests expanded paths and
 * bypasses the server cache.
 */

/** DataGrip-style accent colors, one per object family. */
const KIND_COLORS: Record<SchemaNode["kind"], string> = {
	schema: "#5b9bd5",
	tables: "#4e8cc4",
	views: "#4caf7d",
	functions: "#d8a33b",
	procedures: "#a56fd4",
	sequences: "#4fb3b3",
	table: "#4e8cc4",
	view: "#4caf7d",
	function: "#d8a33b",
	procedure: "#a56fd4",
	sequence: "#4fb3b3",
	column: "#9aa0ab",
	db: "#c14b41",
	prefix: "#5b9bd5",
	key: "#d8a33b",
};

/** Vendor tint for the connection-level cylinder. */
const ADAPTER_COLORS: Record<ConnectionAdapter, string> = {
	postgres: "#5b83b0",
	mysql: "#d98e32",
	sqlite: "#4fb3d9",
	redis: "#c14b41",
};

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
						<TreeIcon kind={props.node.kind} />
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
					<TreeIcon kind={props.node.kind} />
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
					<TreeIcon kind="db" color={ADAPTER_COLORS[connection.adapter]} />
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
