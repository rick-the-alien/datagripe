import type { HistoryEntry, HistoryListResult } from "@datagripe/contracts";
import { useEffect, useState } from "react";
import { wsClient } from "../api/ws";
import { type DocumentsState, useDocumentsStore } from "../stores/documents";
import { useConnectionsStore, useExecutionsStore } from "../stores/runtime";
import { useViewsStore } from "../stores/views";
import { downloadText, toCsv, toJson } from "../utils/export";

function documentsTitle(
	state: DocumentsState,
	documentId: string | undefined,
): string | undefined {
	return documentId === undefined
		? undefined
		: state.documents[documentId]?.title.replace(/\.sql$/, "");
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

function HistoryView() {
	const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
	useEffect(() => {
		void wsClient
			.request<HistoryListResult>("history.list", { limit: 20, offset: 0 })
			.then((result) => setEntries(result.entries))
			.catch(() => setEntries([]));
	}, []);

	if (entries === null) {
		return <div className="dg-tree-note">Loading history…</div>;
	}
	if (entries.length === 0) {
		return <div className="dg-tree-note">No executions yet.</div>;
	}
	return (
		<table className="dg-grid">
			<thead>
				<tr>
					<th>Time</th>
					<th>Status</th>
					<th>Connection</th>
					<th>Rows</th>
					<th>Query</th>
				</tr>
			</thead>
			<tbody>
				{entries.map((entry) => (
					<tr key={entry.id}>
						<td>
							{entry.startedAt === null
								? "—"
								: new Date(entry.startedAt).toLocaleTimeString()}
						</td>
						<td>{entry.status}</td>
						<td>{entry.connectionName}</td>
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
	const execution = useExecutionsStore((state) =>
		latestId === undefined ? undefined : state.executions[latestId],
	);
	const runError = useExecutionsStore((state) =>
		documentId === undefined ? undefined : state.runErrors[documentId],
	);
	const connections = useConnectionsStore((state) => state.connections);
	const defaultConnectionId = useDocumentsStore((state) =>
		documentId === undefined
			? undefined
			: state.prefs[documentId]?.defaultConnectionId,
	);
	const [showHistory, setShowHistory] = useState(false);

	const executions = useExecutionsStore.getState();
	const documents = useDocumentsStore.getState();

	const resultSet =
		execution !== undefined && execution.resultSets.length > 0
			? execution.resultSets[execution.resultSets.length - 1]
			: undefined;

	return (
		<div className="dg-results">
			<div className="dg-results-toolbar">
				<select
					className="dg-connection-select"
					value={defaultConnectionId ?? ""}
					disabled={documentId === undefined}
					onChange={(event) => {
						if (documentId !== undefined && event.target.value !== "") {
							documents.setDefaultConnection(documentId, event.target.value);
						}
					}}
				>
					<option value="" disabled>
						Choose connection…
					</option>
					{connections.map((connection) => (
						<option key={connection.id} value={connection.id}>
							{connection.name}
						</option>
					))}
				</select>
				<button
					type="button"
					disabled={lastEditorViewId === null}
					title="Run selection or statement (Ctrl+Enter)"
					onClick={() => {
						if (lastEditorViewId !== null) {
							void executions.run(lastEditorViewId, "auto");
						}
					}}
				>
					Run
				</button>
				<button
					type="button"
					disabled={lastEditorViewId === null}
					title="Run whole document (Ctrl+Shift+Enter)"
					onClick={() => {
						if (lastEditorViewId !== null) {
							void executions.run(lastEditorViewId, "document");
						}
					}}
				>
					Run all
				</button>
				{(execution?.status === "running" ||
					execution?.status === "queued") && (
					<button
						type="button"
						className="dg-cancel"
						onClick={() => void executions.cancel(execution.id)}
					>
						Cancel
					</button>
				)}
				<span className="dg-results-status">
					{execution === undefined && runError === undefined && "No results"}
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
					<>
						<button
							type="button"
							title="Download result set as CSV"
							onClick={() => {
								const title =
									documentsTitle(useDocumentsStore.getState(), documentId) ??
									"result";
								downloadText(
									`${title}.csv`,
									toCsv(resultSet.columns, resultSet.rows),
									"text/csv",
								);
							}}
						>
							CSV
						</button>
						<button
							type="button"
							title="Download result set as JSON"
							onClick={() => {
								const title =
									documentsTitle(useDocumentsStore.getState(), documentId) ??
									"result";
								downloadText(
									`${title}.json`,
									toJson(resultSet.columns, resultSet.rows),
									"application/json",
								);
							}}
						>
							JSON
						</button>
					</>
				)}
				<button
					type="button"
					onClick={() => setShowHistory((current) => !current)}
				>
					{showHistory ? "Results" : "History"}
				</button>
			</div>

			{showHistory ? (
				<div className="dg-results-body">
					<HistoryView />
				</div>
			) : (
				<div className="dg-results-body">
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
													{row.map((value, columnIndex) => {
														const cell = cellText(value);
														return (
															<td
																key={
																	resultSet.columns[columnIndex]?.name ??
																	columnIndex
																}
																className={cell.isNull ? "dg-grid-null" : ""}
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
