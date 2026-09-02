import type { ColumnDescriptor, ExecutionStatus } from "@datagripe/contracts";
import type { ServerEvent } from "@datagripe/contracts/ws";
import { splitStatements, statementAt } from "@datagripe/sql-tools";
import { create } from "zustand";
import type { WsRequestFn } from "../api/ws";
import { ensureResultsPanel } from "../app/resultsPanel";
import { getEditorHandle } from "../editor/handles";
import { useDocumentsStore } from "./documents";
import { useSessionStore } from "./session";
import { useViewsStore } from "./views";

/** A connection ref as stored on workspaces: managed id or predefined:<slug>. */
export function refToConnectionId(ref: string | null): string | undefined {
	if (ref === null) {
		return undefined;
	}
	return ref.startsWith("predefined:") ? ref.slice("predefined:".length) : ref;
}

/**
 * Client execution state (docs/spec/query-execution.md): accumulates
 * streamed columns/rows per execution, fed by server events. The Results
 * panel renders the active document's latest execution.
 */

export type RunMode = "auto" | "document";

export interface ResultSetData {
	columns: ColumnDescriptor[];
	rows: unknown[][];
}

export interface ExecutionProgress {
	statement: number;
	command: string;
	affectedRows?: number | undefined;
}

export interface ExecutionViewState {
	id: string;
	documentId?: string | undefined;
	connectionId: string;
	/** Executor identity from execution.started (cancel permission, 6d). */
	executorUserId?: string | undefined;
	status: ExecutionStatus;
	statements: number;
	resultSets: ResultSetData[];
	progress: ExecutionProgress[];
	rowCount?: number | undefined;
	truncated?: boolean | undefined;
	elapsedMs?: number | undefined;
	error?: { code?: string | undefined; message: string } | undefined;
	startedAt?: string | undefined;
}

/**
 * Gutter glyph for one executed statement: document offsets captured at
 * run time plus the statement's last known result state. Rendered by
 * EditorView as a glyph-margin decoration.
 */
export interface StatementMarker {
	id: string;
	/** Real execution id once execution.start resolves; a `pending:*`
	 * placeholder before that. */
	executionId: string;
	start: number;
	end: number;
	status: ExecutionStatus;
	message?: string | undefined;
}

export type ExecutionsState = {
	executions: Record<string, ExecutionViewState>;
	latestByDocument: Record<string, string>;
	/** Start-failures that never produced an execution (per document). */
	runErrors: Record<string, string>;
	/** Last-run result glyphs per statement, by document id. */
	statementMarkers: Record<string, StatementMarker[]>;
	/** Events that arrived before their execution.start response (fast
	 * executions race the response on the wire). Drained on register. */
	earlyEvents: Record<string, ServerEvent[]>;
	/** A member's execution opened from history (6d); overrides the
	 * active document's latest execution in the results panel. */
	viewingExecutionId: string | null;
	run: (viewId: string, mode: RunMode) => Promise<void>;
	cancel: (executionId: string) => Promise<void>;
	/** Replay another member's execution into the results panel and
	 * subscribe this socket to its live row batches. */
	openSharedExecution: (executionId: string) => Promise<void>;
	clearViewing: () => void;
	/** Drop all execution state (workspace switch). */
	reset: () => void;
	handleEvent: (event: ServerEvent) => void;
};

export function createExecutionsStore(request: WsRequestFn) {
	return create<ExecutionsState>()((set, get) => {
		const patch = (id: string, partial: Partial<ExecutionViewState>) => {
			const current = get().executions[id];
			if (current === undefined) {
				return;
			}
			set({
				executions: {
					...get().executions,
					[id]: { ...current, ...partial },
				},
			});
		};

		/**
		 * Apply a transition to the markers of one execution (an execution
		 * belongs to exactly one document). `index` is the marker's ordinal
		 * within its execution — the 0-based counterpart of the 1-based
		 * statement number in execution.progress events.
		 */
		const patchMarkers = (
			executionId: string,
			transition: (marker: StatementMarker, index: number) => StatementMarker,
		) => {
			for (const [documentId, markers] of Object.entries(
				get().statementMarkers,
			)) {
				if (!markers.some((marker) => marker.executionId === executionId)) {
					continue;
				}
				let index = 0;
				let changed = false;
				const next = markers.map((marker) => {
					if (marker.executionId !== executionId) {
						return marker;
					}
					const patched = transition(marker, index);
					index += 1;
					if (patched !== marker) {
						changed = true;
					}
					return patched;
				});
				if (changed) {
					set({
						statementMarkers: {
							...get().statementMarkers,
							[documentId]: next,
						},
					});
				}
				return;
			}
		};

		function applyEvent(id: string, event: ServerEvent): void {
			const current = get().executions[id];
			if (current === undefined) {
				return;
			}
			switch (event.topic) {
				case "execution.started": {
					const payload = event.payload as {
						startedAt: string;
						statements: number;
						userId: string;
					};
					patch(id, {
						status: "running",
						startedAt: payload.startedAt,
						statements: payload.statements,
						executorUserId: payload.userId,
					});
					break;
				}
				case "execution.columns": {
					const payload = event.payload as {
						resultSet: number;
						columns: ColumnDescriptor[];
					};
					const resultSets = [...current.resultSets];
					resultSets[payload.resultSet] = {
						columns: payload.columns,
						rows: [],
					};
					patch(id, { resultSets });
					break;
				}
				case "execution.rows": {
					const payload = event.payload as {
						resultSet: number;
						rows: unknown[][];
					};
					const resultSets = [...current.resultSets];
					const existing = resultSets[payload.resultSet] ?? {
						columns: [],
						rows: [],
					};
					resultSets[payload.resultSet] = {
						...existing,
						rows: [...existing.rows, ...payload.rows],
					};
					patch(id, { resultSets });
					break;
				}
				case "execution.progress": {
					const payload = event.payload as ExecutionProgress;
					patch(id, { progress: [...current.progress, payload] });
					patchMarkers(id, (marker, index) =>
						index === payload.statement - 1 && marker.status !== "succeeded"
							? { ...marker, status: "succeeded" }
							: marker,
					);
					break;
				}
				case "execution.completed": {
					const payload = event.payload as {
						rowCount: number;
						truncated: boolean;
						elapsedMs: number;
					};
					patch(id, {
						status: "succeeded",
						rowCount: payload.rowCount,
						truncated: payload.truncated,
						elapsedMs: payload.elapsedMs,
					});
					patchMarkers(id, (marker) =>
						marker.status === "succeeded"
							? marker
							: { ...marker, status: "succeeded" },
					);
					break;
				}
				case "execution.failed": {
					const payload = event.payload as {
						code?: string;
						message: string;
					};
					patch(id, {
						status: "failed",
						error: {
							...(payload.code !== undefined ? { code: payload.code } : {}),
							message: payload.message,
						},
					});
					// Statements before it reported progress; the one at the current
					// progress count is the one that failed. Later statements are
					// left as-is.
					patchMarkers(id, (marker, index) =>
						index === current.progress.length && marker.status !== "succeeded"
							? { ...marker, status: "failed", message: payload.message }
							: marker,
					);
					break;
				}
				case "execution.cancelled": {
					const payload = event.payload as { elapsedMs: number };
					patch(id, {
						status: "cancelled",
						elapsedMs: payload.elapsedMs,
					});
					patchMarkers(id, (marker) =>
						marker.status === "succeeded"
							? marker
							: { ...marker, status: "cancelled" },
					);
					break;
				}
			}
		}

		return {
			executions: {},
			latestByDocument: {},
			runErrors: {},
			statementMarkers: {},
			earlyEvents: {},
			viewingExecutionId: null,

			async run(viewId, mode) {
				const view = useViewsStore.getState().views[viewId];
				const documentId = view?.documentId;
				if (documentId === undefined) {
					return;
				}
				const handle = getEditorHandle(viewId);
				if (handle === undefined) {
					return;
				}

				let sql: string;
				let ranges: Array<{ start: number; end: number }> = [];
				if (mode === "document") {
					sql = handle.getText();
					ranges = splitStatements(sql).map((statement) => ({
						start: statement.start,
						end: statement.end,
					}));
				} else {
					const selection = handle.getSelection();
					if (selection.isEmpty) {
						const statement = statementAt(
							handle.getText(),
							handle.getCursorOffset(),
						);
						sql = statement?.text ?? "";
						if (statement !== null) {
							ranges = [{ start: statement.start, end: statement.end }];
						}
					} else {
						sql = selection.text;
						const offsets = handle.getSelectionOffsets();
						if (offsets !== null) {
							ranges = [offsets];
						}
					}
				}
				if (sql.trim().length === 0) {
					return;
				}

				const connectionId =
					useDocumentsStore.getState().prefs[documentId]?.defaultConnectionId ??
					refToConnectionId(
						useSessionStore.getState().currentWorkspace?.defaultConnectionRef ??
							null,
					);
				if (connectionId === undefined) {
					set({
						runErrors: {
							...get().runErrors,
							[documentId]:
								"Choose a connection for this document (Results panel).",
						},
					});
					ensureResultsPanel();
					return;
				}

				ensureResultsPanel();
				// Gutter glyphs: one queued marker per statement. Old markers whose
				// range intersects a re-run statement are replaced; markers for
				// statements outside this run survive.
				const pendingExecutionId = `pending:${crypto.randomUUID()}`;
				const newMarkers: StatementMarker[] = ranges.map((range) => ({
					id: crypto.randomUUID(),
					executionId: pendingExecutionId,
					start: range.start,
					end: range.end,
					status: "queued",
				}));
				if (newMarkers.length > 0) {
					const existing = get().statementMarkers[documentId] ?? [];
					const kept = existing.filter(
						(old) =>
							!newMarkers.some(
								(marker) => marker.start < old.end && old.start < marker.end,
							),
					);
					set({
						statementMarkers: {
							...get().statementMarkers,
							[documentId]: [...kept, ...newMarkers],
						},
					});
				}
				try {
					const result = await request<{ executionId: string }>(
						"execution.start",
						{
							connectionId,
							documentId,
							editorViewId: viewId,
							sql,
							idempotencyKey: crypto.randomUUID(),
						},
					);
					const execution: ExecutionViewState = {
						id: result.executionId,
						documentId,
						connectionId,
						status: "queued",
						statements: 1,
						resultSets: [],
						progress: [],
					};
					const { [documentId]: _cleared, ...runErrors } = get().runErrors;
					set({
						executions: {
							...get().executions,
							[result.executionId]: execution,
						},
						latestByDocument: {
							...get().latestByDocument,
							[documentId]: result.executionId,
						},
						runErrors,
					});
					// Stamp markers with the real execution id and mark them
					// running; events drained below then move them on.
					patchMarkers(pendingExecutionId, (marker) => ({
						...marker,
						executionId: result.executionId,
						status: "running",
					}));
					// Drain events that raced the response.
					const early = get().earlyEvents[result.executionId];
					if (early !== undefined && early.length > 0) {
						const { [result.executionId]: _drained, ...earlyEvents } =
							get().earlyEvents;
						set({ earlyEvents });
						for (const event of early) {
							applyEvent(result.executionId, event);
						}
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : "Run failed";
					set({
						runErrors: {
							...get().runErrors,
							[documentId]: message,
						},
					});
					patchMarkers(pendingExecutionId, (marker) => ({
						...marker,
						status: "failed",
						message,
					}));
				}
			},

			async cancel(executionId) {
				await request("execution.cancel", { executionId });
			},

			async openSharedExecution(executionId) {
				// Register a placeholder so replayed and live events apply.
				if (get().executions[executionId] === undefined) {
					set({
						executions: {
							...get().executions,
							[executionId]: {
								id: executionId,
								connectionId: "",
								status: "queued",
								statements: 1,
								resultSets: [],
								progress: [],
							},
						},
					});
				}
				set({ viewingExecutionId: executionId });
				try {
					const result = await request<{
						events: Array<{
							sequence: number;
							topic: string;
							payload: unknown;
						}>;
					}>("execution.subscribe", { executionId, afterSequence: 0 });
					const events = [...result.events].sort(
						(a, b) => a.sequence - b.sequence,
					);
					for (const buffered of events) {
						applyEvent(executionId, {
							version: 1,
							kind: "event",
							eventId: crypto.randomUUID(),
							topic: buffered.topic,
							executionId,
							sequence: buffered.sequence,
							occurredAt: "",
							payload: buffered.payload,
						} as ServerEvent);
					}
					// Events that raced ahead while we were not subscribed.
					const early = get().earlyEvents[executionId];
					if (early !== undefined) {
						const { [executionId]: _drained, ...earlyEvents } =
							get().earlyEvents;
						set({ earlyEvents });
						for (const event of early) {
							applyEvent(executionId, event);
						}
					}
				} catch (error) {
					patch(executionId, {
						status: "failed",
						error: {
							message:
								error instanceof Error
									? error.message
									: "Execution is no longer available",
						},
					});
				}
			},

			clearViewing() {
				set({ viewingExecutionId: null });
			},

			reset() {
				set({
					executions: {},
					latestByDocument: {},
					runErrors: {},
					statementMarkers: {},
					earlyEvents: {},
					viewingExecutionId: null,
				});
			},

			handleEvent(event) {
				if (event.executionId === undefined) {
					return;
				}
				const id = event.executionId;
				if (get().executions[id] === undefined) {
					// Fast executions emit before their start response arrives;
					// buffer and drain on registration.
					const buffered = get().earlyEvents[id] ?? [];
					if (buffered.length < 500) {
						set({
							earlyEvents: {
								...get().earlyEvents,
								[id]: [...buffered, event],
							},
						});
					}
					return;
				}
				applyEvent(id, event);
			},
		};
	});
}

export type ExecutionsStore = ReturnType<typeof createExecutionsStore>;
