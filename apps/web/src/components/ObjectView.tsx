import type { ObjectDescribeResult, ObjectTab } from "@datagripe/contracts";
import {
	ADAPTER_CAPABILITIES,
	isRelationKind,
	objectTabSchema,
	tabsForKind,
} from "@datagripe/contracts";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { wsClient } from "../api/ws";
import { openTableView, readViewPanelParams } from "../app/viewPanels";
import {
	PROJECT_CLASS_COLORS,
	type ProjectClass,
	useBrandingStore,
} from "../stores/branding";
import { useConnectionsStore } from "../stores/runtime";
import { useSessionStore } from "../stores/session";
import { ColumnsTab } from "./ColumnsTab";

/**
 * Object view (docs/spec/object-view.md, brand-system.md "Object view —
 * the structure"): tabs across the top, danger zone pushed to the right
 * edge behind a divider.
 *
 * There is deliberately no data tab — rows are the table view's job, and
 * that separation is what lets both surfaces be generous with space.
 */

const TAB_EMPTY: Record<ObjectTab, string> = {
	columns: "This object has no columns.",
	arguments: "This routine takes no arguments.",
	indexes: "No indexes on this object.",
	constraints: "No constraints on this object.",
	triggers: "No triggers on this object.",
	grants: "No grants recorded for this object.",
	statistics: "No statistics available for this object.",
	ddl: "This engine did not return a definition.",
};

/** Why a tab is empty when the engine cannot answer it at all. */
function unsupportedNote(tab: ObjectTab, adapter: string): string {
	return `${adapter} does not expose ${tab} for this object.`;
}

/**
 * Catalog tabs are all the same shape: a header row and cells with one
 * of four tones. Tone is a closed set rather than a free class name so
 * the tabs cannot drift apart visually.
 */
type Tone = "plain" | "pk" | "type" | "mute" | "role";

const TONE_CLASS: Record<Tone, string> = {
	plain: "",
	pk: "dg-ov-pk",
	type: "dg-ov-type",
	mute: "dg-ov-mute",
	role: "dg-ov-role",
};

interface Cell {
	text: string;
	tone: Tone;
}

function cell(text: string, tone: Tone = "plain"): Cell {
	return { text, tone };
}

function Grid(props: { headers: string[]; rows: Cell[][] }) {
	return (
		<table className="dg-grid dg-ov-grid">
			<thead>
				<tr>
					{props.headers.map((header) => (
						<th key={header}>{header}</th>
					))}
				</tr>
			</thead>
			<tbody>
				{props.rows.map((row, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: catalog rows are ordered, not keyed
					<tr key={index}>
						{row.map((entry, cellIndex) => (
							<td
								key={props.headers[cellIndex] ?? cellIndex}
								className={TONE_CLASS[entry.tone]}
							>
								{entry.text}
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}

/**
 * Danger zone gating (brand-system.md "Danger zone"): reveal → type the
 * object name (production: the project name) → execute enables on an
 * exact match. Typing the name is the point — muscle memory cannot fire
 * a destructive action.
 *
 * Execution is not wired up: the brand spec's build order puts the
 * danger zone after the object view precisely because it is the one
 * surface where a bug is destructive, and enforcing the project-class
 * rule server-side needs the class to leave localStorage first
 * (stores/branding.ts).
 */
function DangerAction(props: {
	action: "truncate" | "drop";
	objectName: string;
	projectClass: ProjectClass;
	projectName: string;
	consequences: string;
}) {
	const [typed, setTyped] = useState("");
	const expected =
		props.projectClass === "production" ? props.projectName : props.objectName;
	const armed = typed === expected;

	return (
		<details className="dg-danger-action">
			<summary>
				{props.action} {props.objectName}
			</summary>
			<div className="dg-danger-detail">
				<span>{props.consequences}</span>
				<span>
					Type <code>{expected}</code> to confirm
					{props.projectClass === "production" &&
						" — production confirms with the project name, not the table"}
					.
				</span>
				<input
					value={typed}
					onChange={(event) => setTyped(event.target.value)}
					placeholder={expected}
					aria-label={`Type ${expected} to confirm ${props.action}`}
				/>
				<button type="button" className="dg-danger-execute" disabled={!armed}>
					{props.action}
				</button>
				{armed && (
					<span className="dg-modal-hint">
						Not wired up yet — the danger zone executes in its own change, so
						that a bug here cannot destroy anything today.
					</span>
				)}
			</div>
		</details>
	);
}

function DangerZone(props: {
	data: ObjectDescribeResult;
	projectClass: ProjectClass;
	projectName: string;
}) {
	const { data } = props;
	// A tilde rather than "about", so the phrase composes in both
	// sentences below ("its ~2 rows" reads; "its about 2 rows" does not).
	const rows =
		data.rowEstimate === null
			? "an unknown number of rows"
			: `${data.estimated ? "~" : ""}${data.rowEstimate.toLocaleString()} rows`;
	const cascades =
		data.dependents.length === 0
			? "Nothing else depends on it."
			: `${data.dependents.length} dependent object${
					data.dependents.length === 1 ? "" : "s"
				} would be affected: ${data.dependents
					.map((dependent) => `${dependent.name} (${dependent.kind})`)
					.join(", ")}.`;

	return (
		<div className="dg-danger-list">
			<div className="dg-results-error">
				These operations are irreversible and nothing here is undoable once
				committed. This is a{" "}
				<span style={{ color: PROJECT_CLASS_COLORS[props.projectClass] }}>
					{props.projectClass}
				</span>{" "}
				project.
			</div>
			<DangerAction
				action="truncate"
				objectName={data.name}
				projectClass={props.projectClass}
				projectName={props.projectName}
				consequences={`Removes all ${rows}. Indexes are kept, sequences are not reset. ${cascades}`}
			/>
			<DangerAction
				action="drop"
				objectName={data.name}
				projectClass={props.projectClass}
				projectName={props.projectName}
				consequences={`Removes the ${data.kind}, its ${rows}, its ${
					data.indexes.length
				} index${data.indexes.length === 1 ? "" : "es"}, and everything that depends on it. ${cascades}`}
			/>
		</div>
	);
}

function TabBody(props: {
	tab: ObjectTab;
	data: ObjectDescribeResult;
	adapterName: string;
	columnEditing: React.ComponentProps<typeof ColumnsTab> | null;
}) {
	const { data, tab } = props;

	if (data.unsupported.includes(tab)) {
		return (
			<div className="dg-tree-note">
				{unsupportedNote(tab, props.adapterName)}
			</div>
		);
	}

	switch (tab) {
		case "columns":
			// The columns tab is the editable one; everything else is a read.
			if (props.columnEditing !== null) {
				return <ColumnsTab {...props.columnEditing} />;
			}
			return data.columns.length === 0 ? (
				<div className="dg-tree-note">{TAB_EMPTY.columns}</div>
			) : (
				<Grid
					headers={["name", "type", "null", "default", "comment"]}
					rows={data.columns.map((column) => [
						cell(column.name, column.primaryKey ? "pk" : "plain"),
						cell(column.dataType, "type"),
						cell(column.nullable ? "null" : "not null", "mute"),
						cell(column.defaultExpr ?? "—", "mute"),
						cell(column.comment ?? "—", "mute"),
					])}
				/>
			);

		case "arguments":
			return data.arguments.length === 0 ? (
				<div className="dg-tree-note">{TAB_EMPTY.arguments}</div>
			) : (
				<Grid
					headers={["name", "type", "mode"]}
					rows={data.arguments.map((argument) => [
						cell(argument.name),
						cell(argument.dataType, "type"),
						cell(argument.mode, "mute"),
					])}
				/>
			);

		case "indexes":
			return data.indexes.length === 0 ? (
				<div className="dg-tree-note">{TAB_EMPTY.indexes}</div>
			) : (
				<Grid
					headers={["name", "method", "columns", "unique", "size"]}
					rows={data.indexes.map((index) => [
						cell(index.name, index.primary ? "pk" : "plain"),
						cell(index.method, "mute"),
						cell(index.columns, "type"),
						cell(index.unique ? "unique" : "—", "mute"),
						cell(
							index.sizeBytes === null ? "—" : formatBytes(index.sizeBytes),
							"mute",
						),
					])}
				/>
			);

		case "constraints":
			return data.constraints.length === 0 ? (
				<div className="dg-tree-note">{TAB_EMPTY.constraints}</div>
			) : (
				<Grid
					headers={["name", "type", "definition"]}
					rows={data.constraints.map((constraint) => [
						cell(
							constraint.name,
							constraint.type === "primary key" ? "pk" : "plain",
						),
						cell(constraint.type, "mute"),
						cell(constraint.definition, "type"),
					])}
				/>
			);

		case "triggers":
			return data.triggers.length === 0 ? (
				<div className="dg-tree-note">{TAB_EMPTY.triggers}</div>
			) : (
				<Grid
					headers={["name", "timing", "event", "action", "enabled"]}
					rows={data.triggers.map((trigger) => [
						cell(trigger.name),
						cell(trigger.timing || "—", "mute"),
						cell(trigger.events || "—", "mute"),
						cell(trigger.action, "type"),
						cell(
							trigger.enabled ? "yes" : "disabled",
							trigger.enabled ? "mute" : "pk",
						),
					])}
				/>
			);

		case "grants":
			return data.grants.length === 0 ? (
				<div className="dg-tree-note">{TAB_EMPTY.grants}</div>
			) : (
				<Grid
					headers={["role", "privileges", "granted by"]}
					rows={data.grants.map((grant) => [
						cell(grant.grantee, "role"),
						cell(grant.privileges, "type"),
						cell(grant.grantor ?? "—", "mute"),
					])}
				/>
			);

		case "statistics":
			return data.statistics.length === 0 ? (
				<div className="dg-tree-note">{TAB_EMPTY.statistics}</div>
			) : (
				<div className="dg-ov-stats">
					{data.statistics.map((stat) => (
						<div key={stat.label}>
							<b>{stat.value}</b>
							<span>{stat.label}</span>
						</div>
					))}
				</div>
			);

		default:
			return data.ddl === null ? (
				<div className="dg-tree-note">{TAB_EMPTY.ddl}</div>
			) : (
				<>
					{data.ddlReconstructed && (
						<div className="dg-tree-note">
							Reconstructed from the catalog — PostgreSQL has no server-side DDL
							export, so this is accurate but not byte-for-byte what was
							executed.
						</div>
					)}
					<pre className="dg-ov-ddl">{data.ddl}</pre>
				</>
			);
	}
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

export function ObjectView(props: IDockviewPanelProps) {
	const params = readViewPanelParams(props.params);
	const connection = useConnectionsStore((state) =>
		state.connections.find((entry) => entry.id === params.connectionId),
	);
	const currentWorkspace = useSessionStore((state) => state.currentWorkspace);
	const projectClass = useBrandingStore((state) =>
		state.classFor(currentWorkspace?.id ?? null),
	);

	// Which tabs exist depends on the kind, and the kind is known from the
	// panel params before the describe lands — so the strip does not
	// reshuffle once data arrives.
	const kindTabs = tabsForKind(params.kind);
	const [tab, setTab] = useState<ObjectTab | "danger">(() => {
		const requested = objectTabSchema.safeParse(params.tab);
		if (requested.success && kindTabs.includes(requested.data)) {
			return requested.data;
		}
		return params.tab === "danger" ? "danger" : (kindTabs[0] as ObjectTab);
	});
	const [data, setData] = useState<ObjectDescribeResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	// Deep links (context menu → indexes) retarget an already-open panel,
	// but only when the param actually changes — otherwise the deep link
	// would override every manual tab switch.
	const appliedDeepLink = useRef(params.tab);
	if (params.tab !== appliedDeepLink.current) {
		appliedDeepLink.current = params.tab;
		const requested = objectTabSchema.safeParse(params.tab);
		if (params.tab === "danger") {
			setTab("danger");
		} else if (requested.success && kindTabs.includes(requested.data)) {
			setTab(requested.data);
		}
	}

	const capabilities =
		connection === undefined
			? undefined
			: ADAPTER_CAPABILITIES[connection.adapter];

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await wsClient.request<ObjectDescribeResult>(
				"object.describe",
				{
					connectionId: params.connectionId,
					schema: params.schema,
					name: params.name,
					kind: params.kind,
				},
			);
			setData(result);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not read the structure",
			);
		} finally {
			setLoading(false);
		}
	}, [params.connectionId, params.schema, params.name, params.kind]);

	useEffect(() => {
		if (capabilities?.introspection !== "sql") {
			return;
		}
		void load();
	}, [load, capabilities?.introspection]);

	if (capabilities !== undefined && capabilities.introspection !== "sql") {
		return (
			<div className="dg-ov">
				<div className="dg-ov-body dg-scroll">
					<div className="dg-tree-note">
						{connection?.name ?? "This datasource"} has no object view — its
						objects are not relations.
					</div>
				</div>
			</div>
		);
	}

	// The class already knows what kind of environment this is, so it does
	// a second job: an analytics replica is read-only and says so.
	const readOnly = projectClass === "analytics";
	const relation = isRelationKind(params.kind);
	const subtitle = [
		params.kind,
		params.schema,
		data?.rowEstimate == null
			? null
			: `${data.estimated ? "~" : ""}${data.rowEstimate.toLocaleString()} rows`,
	]
		.filter((part) => part !== null)
		.join(" · ");

	return (
		<div className="dg-ov">
			<div className="dg-ov-head">
				<div className="dg-ov-title">
					<b>{params.name}</b>
					<span>{subtitle}</span>
					<span className="dg-modal-actions-spacer" />
					<button
						type="button"
						className="dg-tv-ico"
						title="Refresh"
						aria-label="Refresh"
						disabled={loading}
						onClick={() => void load()}
					>
						↻
					</button>
					{relation && (
						<button
							type="button"
							className="dg-ov-rows"
							title="Open this object's rows"
							onClick={() =>
								openTableView({
									connectionId: params.connectionId,
									schema: params.schema,
									name: params.name,
									kind: params.kind,
								})
							}
						>
							▤ rows
						</button>
					)}
				</div>
				<div className="dg-ov-tabs" role="tablist">
					{(data?.tabs ?? kindTabs).map((value) => (
						<button
							key={value}
							type="button"
							className="dg-ov-tab"
							role="tab"
							aria-selected={tab === value}
							onClick={() => setTab(value)}
						>
							{value}
						</button>
					))}
					{/* truncate and drop are relation operations; a routine's
					    danger zone would be a different set and does not exist
					    yet. */}
					{relation && (
						<button
							type="button"
							className="dg-ov-tab dg-ov-tab-danger"
							role="tab"
							aria-selected={tab === "danger"}
							disabled={readOnly}
							title={
								readOnly
									? "Read-only analytics replica — writes are blocked"
									: "Irreversible operations"
							}
							onClick={() => setTab("danger")}
						>
							danger zone
						</button>
					)}
				</div>
			</div>

			<div className="dg-ov-body dg-scroll">
				{error !== null && <div className="dg-results-error">{error}</div>}
				{data === null && error === null && (
					<div className="dg-tree-note dg-tree-note-loading">loading…</div>
				)}
				{data !== null && tab !== "danger" && (
					<TabBody
						tab={tab}
						data={data}
						adapterName={connection?.adapter ?? "This engine"}
						columnEditing={
							// A view's columns come from its query and a routine has
							// none, so only a base table's columns are editable.
							params.kind === "table" && capabilities !== undefined
								? {
										data,
										supported: capabilities.columnChanges,
										canEdit: currentWorkspace?.role !== "viewer" && !readOnly,
										readOnlyReason:
											currentWorkspace?.role === "viewer"
												? "viewers cannot change structure"
												: readOnly
													? "read-only analytics replica"
													: null,
										connectionId: params.connectionId,
										onApplied: () => void load(),
									}
								: null
						}
					/>
				)}
				{data !== null && tab === "danger" && (
					<DangerZone
						data={data}
						projectClass={projectClass}
						projectName={currentWorkspace?.name ?? ""}
					/>
				)}
			</div>
		</div>
	);
}
