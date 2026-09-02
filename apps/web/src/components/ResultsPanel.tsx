import type {
	ColumnDescriptor,
	ConnectionMetadata,
	HistoryEntry,
	HistoryListResult,
} from "@datagripe/contracts";
import { ADAPTER_CAPABILITIES } from "@datagripe/contracts";
import { useEffect, useRef, useState } from "react";
import { wsClient } from "../api/ws";
import { ENGINE_CHIPS } from "../stores/datasource";
import { type DocumentsState, useDocumentsStore } from "../stores/documents";
import { refToConnectionId } from "../stores/executions";
import { useConnectionsStore, useExecutionsStore } from "../stores/runtime";
import { useSessionStore } from "../stores/session";
import { useViewsStore } from "../stores/views";
import {
	downloadText,
	EXPORT_FORMATS,
	type ExportFormat,
	toCsv,
	toJson,
	toMarkdown,
	toTsv,
} from "../utils/export";

function documentsTitle(
	state: DocumentsState,
	documentId: string | undefined,
): string | undefined {
	return documentId === undefined
		? undefined
		: state.documents[documentId]?.title.replace(/\.sql$/, "");
}

/** One format drives both download and clipboard (mocks/results-tab.html "Export and
 * copy"): csv, json, tsv, markdown. sql inserts are dropped — the table name is not
 * derivable from an ad-hoc result set. */
const FORMAT_STORAGE_KEY = "dg.exportFormat";

/**
 * Results target selector styled after the sidebar breadcrumb's datasource popover (docs/brand/mocks/
 * datasource-selector.html): engine chip + name + chevron, popover with neutral engine monograms.
 */
function TargetSelect(props: {
	connections: ConnectionMetadata[];
	value: string | undefined;
	disabled: boolean;
	onChange: (connectionId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const close = () => setOpen(false);
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
			}
		};
		window.addEventListener("mousedown", close);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", close);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const current = props.connections.find(
		(connection) => connection.id === props.value,
	);
	const anchor = rootRef.current?.getBoundingClientRect();

	return (
		<div ref={rootRef} className="dg-tgt">
			<button
				type="button"
				className="dg-crumb-seg"
				disabled={props.disabled}
				aria-expanded={open}
				aria-haspopup="true"
				aria-label="Execution target"
				onClick={() => setOpen((value) => !value)}
			>
				{current !== undefined && (
					<span className="dg-crumb-chip">{ENGINE_CHIPS[current.adapter]}</span>
				)}
				<span className="dg-crumb-name">
					{current?.name ?? "choose connection…"}
				</span>
				<span className="dg-crumb-chev">▾</span>
			</button>
			{open && anchor !== undefined && (
				<div
					className="dg-crumb-pop dg-scroll"
					role="menu"
					style={{
						position: "fixed",
						top: anchor.bottom + 4,
						left: anchor.left,
					}}
				>
					{props.connections.map((connection) => (
						<button
							key={connection.id}
							type="button"
							role="menuitem"
							className={`dg-crumb-item dg-crumb-item-main${
								connection.id === props.value ? " dg-crumb-item-cur" : ""
							}`}
							onClick={() => {
								setOpen(false);
								props.onChange(connection.id);
							}}
						>
							<span className="dg-crumb-chip">
								{ENGINE_CHIPS[connection.adapter]}
							</span>
							{connection.name}
							<span className="dg-crumb-sub">{connection.adapter}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
	csv: "csv",
	json: "json",
	tsv: "tsv",
	markdown: "md",
};

const FORMAT_MIMES: Record<ExportFormat, string> = {
	csv: "text/csv",
	json: "application/json",
	tsv: "text/tab-separated-values",
	markdown: "text/markdown",
};

function formatResultSet(
	format: ExportFormat,
	columns: ColumnDescriptor[],
	rows: unknown[][],
): string {
	switch (format) {
		case "json":
			return toJson(columns, rows);
		case "tsv":
			return toTsv(columns, rows);
		case "markdown":
			return toMarkdown(columns, rows);
		default:
			return toCsv(columns, rows);
	}
}

function readFormat(): ExportFormat {
	try {
		const value = localStorage.getItem(FORMAT_STORAGE_KEY);
		return EXPORT_FORMATS.includes(value as ExportFormat)
			? (value as ExportFormat)
			: "csv";
	} catch {
		return "csv";
	}
}

/**
 * Results panel (docs/spec/query-execution.md): follows the active
 * editor's latest execution — connection picker, status line with
 * cancel, data grid, inline errors, and a history list.
 */

const RENDERED_ROW_LIMIT = 1_000;

function cellText(value: unknown): { text: string; isNull: boolean } {
	if (value === null || value === undefined) {
		return { text: "NULL", isNull: true };
	}
	if (typeof value === "object") {
		return { text: JSON.stringify(value), isNull: false };
	}
	return { text: String(value), isNull: false };
}

function HistoryView(props: {
	onOpenExecution: (executionId: string) => void;
}) {
	const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
	const [scope, setScope] = useState<"mine" | "workspace">("mine");
	useEffect(() => {
		setEntries(null);
		void wsClient
			.request<HistoryListResult>("history.list", {
				limit: 20,
				offset: 0,
				scope,
			})
			.then((result) => setEntries(result.entries))
			.catch(() => setEntries([]));
	}, [scope]);

	if (entries === null) {
		return <div className="dg-tree-note">Loading history…</div>;
	}
	return (
		<>
			<fieldset className="dg-history-scope">
				<legend className="dg-visually-hidden">History scope</legend>
				<button
					type="button"
					aria-pressed={scope === "mine"}
					onClick={() => setScope("mine")}
				>
					Mine
				</button>
				<button
					type="button"
					aria-pressed={scope === "workspace"}
					onClick={() => setScope("workspace")}
				>
					Everyone
				</button>
			</fieldset>
			{entries.length === 0 ? (
				<div className="dg-tree-note">No executions yet.</div>
			) : (
				<table className="dg-grid">
					<thead>
						<tr>
							<th>Time</th>
							<th>Status</th>
							<th>Connection</th>
							{scope === "workspace" && <th>Actor</th>}
							<th>Rows</th>
							<th>Query</th>
						</tr>
					</thead>
					<tbody>
						{entries.map((entry) => (
							<tr
								key={entry.id}
								className="dg-history-row"
								title="Open this execution's results"
								onClick={() => props.onOpenExecution(entry.id)}
							>
								<td>
									{entry.startedAt === null
										? "—"
										: new Date(entry.startedAt).toLocaleTimeString()}
								</td>
								<td>
									{entry.status}
									{(entry.status === "running" || entry.status === "queued") &&
										" ●"}
								</td>
								<td>{entry.connectionName}</td>
								{scope === "workspace" && <td>{entry.actorEmail}</td>}
								<td>
									{entry.rowCount ?? "—"}
									{entry.truncated === true ? "+" : ""}
								</td>
								<td className="dg-grid-clip" title={entry.preview}>
									{entry.preview}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</>
	);
}

export function ResultsPanel() {
	const lastEditorViewId = useViewsStore((state) => state.lastEditorViewId);
	const documentId = useViewsStore((state) =>
		state.lastEditorViewId !== null
			? state.views[state.lastEditorViewId]?.documentId
			: undefined,
	);
	const latestId = useExecutionsStore((state) =>
		documentId === undefined ? undefined : state.latestByDocument[documentId],
	);
	const viewingExecutionId = useExecutionsStore(
		(state) => state.viewingExecutionId,
	);
	const execution = useExecutionsStore((state) =>
		viewingExecutionId !== null
			? state.executions[viewingExecutionId]
			: latestId === undefined
				? undefined
				: state.executions[latestId],
	);
	const runError = useExecutionsStore((state) =>
		documentId === undefined ? undefined : state.runErrors[documentId],
	);
	const connections = useConnectionsStore((state) => state.connections);
	const docConnectionId = useDocumentsStore((state) =>
		documentId === undefined
			? undefined
			: state.prefs[documentId]?.defaultConnectionId,
	);
	const currentWorkspace = useSessionStore((state) => state.currentWorkspace);
	const workspaceDefaultId = refToConnectionId(
		currentWorkspace?.defaultConnectionRef ?? null,
	);
	const defaultConnectionId = docConnectionId ?? workspaceDefaultId;
	const [showHistory, setShowHistory] = useState(false);
	const [exportFormat, setExportFormat] = useState<ExportFormat>(readFormat);
	const [formatMenuOpen, setFormatMenuOpen] = useState(false);

	const executions = useExecutionsStore.getState();
	const documents = useDocumentsStore.getState();

	const connection = connections.find((c) => c.id === defaultConnectionId);
	const capabilities =
		connection === undefined
			? undefined
			: ADAPTER_CAPABILITIES[connection.adapter];
	const canExecute = capabilities?.execution != null;
	const myUserId = useSessionStore((state) => state.bootstrap?.user?.id);
	const myRole = currentWorkspace?.role;
	const canCancel =
		capabilities?.cancellation === true &&
		execution !== undefined &&
		(execution.executorUserId === undefined ||
			execution.executorUserId === myUserId ||
			myRole === "owner");

	const resultSet =
		execution !== undefined && execution.resultSets.length > 0
			? execution.resultSets[execution.resultSets.length - 1]
			: undefined;

	// Format menu dismisses on outside click / Escape.
	useEffect(() => {
		if (!formatMenuOpen) {
			return;
		}
		const close = () => setFormatMenuOpen(false);
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setFormatMenuOpen(false);
			}
		};
		window.addEventListener("mousedown", close, true);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", close);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [formatMenuOpen]);

	return (
		<div className="dg-results">
			<div className="dg-results-toolbar">
				<TargetSelect
					connections={connections}
					value={defaultConnectionId}
					disabled={documentId === undefined}
					onChange={(connectionId) => {
						if (documentId !== undefined) {
							documents.setDefaultConnection(documentId, connectionId);
						}
					}}
				/>
				{docConnectionId === undefined && workspaceDefaultId !== undefined && (
					<span className="dg-header-meta">workspace default</span>
				)}
				{docConnectionId !== undefined &&
					myRole !== "viewer" &&
					docConnectionId !== workspaceDefaultId && (
						<button
							type="button"
							className="dg-pin"
							title="Use this connection for the whole workspace"
							onClick={() => {
								const connection = connections.find(
									(c) => c.id === docConnectionId,
								);
								if (connection === undefined) {
									return;
								}
								const ref =
									connection.source === "predefined"
										? `predefined:${connection.id}`
										: connection.id;
								void wsClient
									.request("workspace.set-default-connection", {
										connectionRef: ref,
									})
									.then(() => {
										const current = useSessionStore.getState().currentWorkspace;
										if (current !== null) {
											useSessionStore.getState().confirmWorkspace({
												...current,
												defaultConnectionRef: ref,
											});
										}
									});
							}}
						>
							⧉ workspace
						</button>
					)}
				<span className="dg-vsep" />
				<button
					type="button"
					className="dg-run-icon"
					disabled={lastEditorViewId === null || !canExecute}
					title={
						canExecute
							? "Run selection or statement (Ctrl+Enter)"
							: "This connection does not support SQL execution"
					}
					onClick={() => {
						if (lastEditorViewId !== null) {
							void executions.run(lastEditorViewId, "auto");
						}
					}}
				>
					▶
				</button>
				<button
					type="button"
					className="dg-run-icon"
					disabled={lastEditorViewId === null || !canExecute}
					title={
						canExecute
							? "Run whole document (Ctrl+Shift+Enter)"
							: "This connection does not support SQL execution"
					}
					onClick={() => {
						if (lastEditorViewId !== null) {
							void executions.run(lastEditorViewId, "document");
						}
					}}
				>
					⏭
				</button>
				<span className="dg-vsep" />
				{canCancel &&
					(execution?.status === "running" ||
						execution?.status === "queued") && (
						<button
							type="button"
							className="dg-cancel"
							onClick={() => void executions.cancel(execution.id)}
						>
							Cancel
						</button>
					)}
				<fieldset className="dg-seg" aria-label="Output">
					<legend className="dg-visually-hidden">Output mode</legend>
					<button
						type="button"
						aria-pressed={!showHistory}
						onClick={() => setShowHistory(false)}
					>
						table
					</button>
					<button
						type="button"
						aria-pressed={showHistory}
						onClick={() => setShowHistory(true)}
					>
						history
					</button>
				</fieldset>
				<span className="dg-results-status">
					{execution === undefined && runError === undefined && "No results"}
					{viewingExecutionId !== null && (
						<span className="dg-follow-chip">
							Shared execution
							<button
								type="button"
								className="dg-follow-detach"
								aria-label="Back to active document results"
								onClick={() => executions.clearViewing()}
							>
								×
							</button>
						</span>
					)}
					{execution?.status === "queued" && "Queued…"}
					{execution?.status === "running" && "Running…"}
					{execution?.status === "succeeded" &&
						`${execution.rowCount ?? 0} rows${
							execution.truncated === true ? " (truncated)" : ""
						} in ${execution.elapsedMs ?? "?"} ms`}
					{execution?.status === "cancelled" &&
						`Cancelled after ${execution.elapsedMs ?? "?"} ms`}
				</span>
				<span className="dg-modal-actions-spacer" />
				{resultSet !== undefined && resultSet.columns.length > 0 && (
					<div className="dg-exp">
						<button
							type="button"
							className="dg-exp-eb"
							title={`Download ${exportFormat}`}
							onClick={() => {
								const title =
									documentsTitle(useDocumentsStore.getState(), documentId) ??
									"result";
								downloadText(
									`${title}.${FORMAT_EXTENSIONS[exportFormat]}`,
									formatResultSet(
										exportFormat,
										resultSet.columns,
										resultSet.rows,
									),
									FORMAT_MIMES[exportFormat],
								);
							}}
						>
							⬇
						</button>
						<button
							type="button"
							className="dg-exp-eb"
							title={`Copy ${exportFormat}`}
							onClick={() => {
								void navigator.clipboard.writeText(
									formatResultSet(
										exportFormat,
										resultSet.columns,
										resultSet.rows,
									),
								);
							}}
						>
							⧉
						</button>
						<div className="dg-exp-ec-wrap">
							<button
								type="button"
								className="dg-exp-ec"
								aria-expanded={formatMenuOpen}
								aria-label="Format"
								title={`Format: ${exportFormat}`}
								onClick={() => setFormatMenuOpen((current) => !current)}
							>
								▾
							</button>
							{formatMenuOpen && (
								<div className="dg-exp-fmt dg-scroll" role="menu">
									<div className="dg-exp-fmt-hd">format for both</div>
									{EXPORT_FORMATS.map((format) => (
										<button
											key={format}
											type="button"
											role="menuitem"
											className="dg-exp-fmt-it"
											onClick={() => {
												setExportFormat(format);
												setFormatMenuOpen(false);
												try {
													localStorage.setItem(FORMAT_STORAGE_KEY, format);
												} catch {
													// Storage blocked — format stays per-session.
												}
											}}
										>
											<span className="dg-exp-fmt-tick">
												{format === exportFormat ? "✓" : ""}
											</span>
											{format}
										</button>
									))}
								</div>
							)}
						</div>
					</div>
				)}
			</div>

			{showHistory ? (
				<div className="dg-results-body dg-scroll">
					<HistoryView
						onOpenExecution={(executionId) => {
							void executions.openSharedExecution(executionId);
							setShowHistory(false);
						}}
					/>
				</div>
			) : (
				<div className="dg-results-body dg-scroll">
					{runError !== undefined && (
						<div className="dg-results-error">{runError}</div>
					)}
					{execution?.error !== undefined && (
						<div className="dg-results-error">
							{execution.error.code !== undefined &&
								`[${execution.error.code}] `}
							{execution.error.message}
						</div>
					)}
					{execution !== undefined &&
						resultSet === undefined &&
						execution.status !== "failed" && (
							<div className="dg-tree-note">
								{execution.progress.length > 0
									? execution.progress
											.map(
												(p) =>
													`${p.command}${
														p.affectedRows !== undefined
															? ` ${p.affectedRows}`
															: ""
													}`,
											)
											.join(" · ")
									: "Statement produced no result set."}
							</div>
						)}
					{resultSet !== undefined && (
						<>
							{resultSet.columns.length === 0 ? (
								<div className="dg-tree-note">Query returned no rows.</div>
							) : (
								<table className="dg-grid">
									<thead>
										<tr>
											<th className="dg-grid-rn" aria-label="Row number" />
											{resultSet.columns.map((column) => (
												<th key={column.name}>{column.name}</th>
											))}
										</tr>
									</thead>
									<tbody>
										{resultSet.rows
											.slice(0, RENDERED_ROW_LIMIT)
											.map((row, rowIndex) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: append-only grid rows have no stable identity
												<tr key={rowIndex}>
													<td className="dg-grid-rn">{rowIndex + 1}</td>
													{row.map((value, columnIndex) => {
														const cell = cellText(value);
														// Brand: numerics right-aligned and coloured,
														// everything else neutral.
														const numeric =
															!cell.isNull && typeof value === "number";
														return (
															<td
																key={
																	resultSet.columns[columnIndex]?.name ??
																	columnIndex
																}
																className={
																	cell.isNull
																		? "dg-grid-null"
																		: numeric
																			? "dg-grid-num"
																			: ""
																}
															>
																{cell.text}
															</td>
														);
													})}
												</tr>
											))}
									</tbody>
								</table>
							)}
							{resultSet.rows.length > RENDERED_ROW_LIMIT && (
								<div className="dg-tree-note">
									Showing first {RENDERED_ROW_LIMIT} of {resultSet.rows.length}{" "}
									rows.
								</div>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}
