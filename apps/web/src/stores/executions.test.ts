import { expect, test } from "bun:test";
import type { ServerEvent } from "@datagripe/contracts/ws";
import { type EditorHandle, registerEditorHandle } from "../editor/handles";
import { useDocumentsStore } from "./documents";
import { createExecutionsStore } from "./executions";
import { useViewsStore } from "./views";

/**
 * Regression: fast executions emit lifecycle events that can reach the
 * client BEFORE the execution.start response. Events must buffer and
 * drain on registration, not drop (the sqlite smoke exposed this).
 */

const EXEC_ID = "11111111-1111-4111-8111-111111111111";

function event(topic: string, payload: unknown): ServerEvent {
	return {
		version: 1,
		kind: "event",
		eventId: crypto.randomUUID(),
		topic,
		executionId: EXEC_ID,
		sequence: 1,
		occurredAt: new Date().toISOString(),
		payload,
	} as ServerEvent;
}

test("events arriving before the start response are drained on register", async () => {
	// Environment: one view, one editor handle, one document with a
	// default connection.
	useViewsStore.getState().registerView("view-1", "doc-1");
	registerEditorHandle("view-1", {
		getText: () => "select 1",
		getSelection: () => ({ text: "", isEmpty: true }),
		getCursorOffset: () => 0,
		getSelectionOffsets: () => null,
	});
	useDocumentsStore.setState({
		documents: {
			"doc-1": {
				id: "doc-1",
				title: "query-1.sql",
				language: "sql",
				savedContent: "select 1",
				currentContent: "select 1",
				revision: 1,
				dirty: false,
				shared: false,
				createdAt: "2026-08-31T10:00:00.000Z",
				updatedAt: "2026-08-31T10:00:00.000Z",
			},
		},
		order: ["doc-1"],
		prefs: { "doc-1": { defaultConnectionId: "conn-1" } },
		hydrated: true,
	});

	const store = createExecutionsStore(async <T>() => {
		return { executionId: EXEC_ID } as T;
	});

	// Events arrive FIRST (fast execution beats the response).
	store.getState().handleEvent(
		event("execution.started", {
			startedAt: "2026-08-31T12:00:00.000Z",
			statements: 1,
		}),
	);
	store.getState().handleEvent(
		event("execution.columns", {
			resultSet: 0,
			columns: [{ name: "one", dataType: "integer" }],
		}),
	);
	store
		.getState()
		.handleEvent(
			event("execution.rows", { resultSet: 0, rows: [[1]], rowOffset: 0 }),
		);
	store.getState().handleEvent(
		event("execution.completed", {
			rowCount: 1,
			truncated: false,
			elapsedMs: 3,
			statements: 1,
		}),
	);
	expect(store.getState().executions[EXEC_ID]).toBeUndefined();
	expect(store.getState().earlyEvents[EXEC_ID]).toHaveLength(4);

	await store.getState().run("view-1", "auto");

	const execution = store.getState().executions[EXEC_ID];
	expect(execution?.status).toBe("succeeded");
	expect(execution?.resultSets[0]?.rows).toEqual([[1]]);
	expect(execution?.elapsedMs).toBe(3);
	expect(store.getState().earlyEvents[EXEC_ID]).toBeUndefined();
});

/**
 * Statement markers: gutter glyphs for the last run of each statement
 * (docs/spec/query-execution.md). One marker per executed statement,
 * keyed by document, transitioned by execution lifecycle events.
 */

function setupDocument(text: string, handle: Partial<EditorHandle> = {}) {
	useViewsStore.getState().registerView("view-1", "doc-1");
	registerEditorHandle("view-1", {
		getText: () => text,
		getSelection: () => ({ text: "", isEmpty: true }),
		getCursorOffset: () => 0,
		getSelectionOffsets: () => null,
		...handle,
	});
	useDocumentsStore.setState({
		documents: {
			"doc-1": {
				id: "doc-1",
				title: "query-1.sql",
				language: "sql",
				savedContent: text,
				currentContent: text,
				revision: 1,
				dirty: false,
				shared: false,
				createdAt: "2026-08-31T10:00:00.000Z",
				updatedAt: "2026-08-31T10:00:00.000Z",
			},
		},
		order: ["doc-1"],
		prefs: { "doc-1": { defaultConnectionId: "conn-1" } },
		hydrated: true,
	});
}

function createStore() {
	return createExecutionsStore(async <T>() => {
		return { executionId: EXEC_ID } as T;
	});
}

test("auto-run with an empty selection marks the statement at the cursor", async () => {
	setupDocument("select 1;\nselect 22;", { getCursorOffset: () => 12 });
	const store = createStore();

	await store.getState().run("view-1", "auto");

	const markers = store.getState().statementMarkers["doc-1"];
	expect(markers).toHaveLength(1);
	expect(markers?.[0]).toMatchObject({
		start: 10,
		end: 19,
		status: "running",
		executionId: EXEC_ID,
	});
});

test("auto-run with a selection marks the selection offsets", async () => {
	setupDocument("select 1;\nselect 22;", {
		getSelection: () => ({ text: "select 22", isEmpty: false }),
		getSelectionOffsets: () => ({ start: 10, end: 19 }),
	});
	const store = createStore();

	await store.getState().run("view-1", "auto");

	const markers = store.getState().statementMarkers["doc-1"];
	expect(markers).toHaveLength(1);
	expect(markers?.[0]).toMatchObject({ start: 10, end: 19, status: "running" });
});

test("document-run records one marker per statement", async () => {
	setupDocument("select 1;\nselect 22;\nselect 333");
	const store = createStore();

	await store.getState().run("view-1", "document");

	const markers = store.getState().statementMarkers["doc-1"];
	expect(
		markers?.map((marker) => ({ start: marker.start, end: marker.end })),
	).toEqual([
		{ start: 0, end: 8 },
		{ start: 10, end: 19 },
		{ start: 21, end: 31 },
	]);
	expect(markers?.every((marker) => marker.status === "running")).toBe(true);
});

test("progress events mark the Nth statement succeeded", async () => {
	setupDocument("select 1;\nselect 22;");
	const store = createStore();
	await store.getState().run("view-1", "document");

	store
		.getState()
		.handleEvent(
			event("execution.progress", { statement: 1, command: "SELECT" }),
		);

	let markers = store.getState().statementMarkers["doc-1"];
	expect(markers?.[0]?.status).toBe("succeeded");
	expect(markers?.[1]?.status).toBe("running");

	store
		.getState()
		.handleEvent(
			event("execution.progress", { statement: 2, command: "SELECT" }),
		);

	markers = store.getState().statementMarkers["doc-1"];
	expect(markers?.map((marker) => marker.status)).toEqual([
		"succeeded",
		"succeeded",
	]);
});

test("completion marks every statement of the execution succeeded", async () => {
	setupDocument("select 1;\nselect 22;");
	const store = createStore();
	await store.getState().run("view-1", "document");

	store.getState().handleEvent(
		event("execution.completed", {
			rowCount: 2,
			truncated: false,
			elapsedMs: 5,
			statements: 2,
		}),
	);

	const markers = store.getState().statementMarkers["doc-1"];
	expect(markers?.map((marker) => marker.status)).toEqual([
		"succeeded",
		"succeeded",
	]);
});

test("failure marks the failing statement with the error message", async () => {
	setupDocument("select 1;\nselect 22;");
	const store = createStore();
	await store.getState().run("view-1", "document");
	store
		.getState()
		.handleEvent(
			event("execution.progress", { statement: 1, command: "SELECT" }),
		);

	store
		.getState()
		.handleEvent(event("execution.failed", { message: "syntax error" }));

	const markers = store.getState().statementMarkers["doc-1"];
	expect(markers?.[0]?.status).toBe("succeeded");
	expect(markers?.[1]).toMatchObject({
		status: "failed",
		message: "syntax error",
	});
});

test("a re-run replaces only the markers it intersects", async () => {
	setupDocument("select 1;\nselect 22;");
	const store = createStore();
	await store.getState().run("view-1", "document");
	store.getState().handleEvent(
		event("execution.completed", {
			rowCount: 2,
			truncated: false,
			elapsedMs: 5,
			statements: 2,
		}),
	);

	// Re-run only the first statement; the second keeps its old glyph.
	await store.getState().run("view-1", "auto");

	const markers = store.getState().statementMarkers["doc-1"];
	expect(markers).toHaveLength(2);
	expect(markers?.find((marker) => marker.start === 0)?.status).toBe("running");
	expect(markers?.find((marker) => marker.start === 10)?.status).toBe(
		"succeeded",
	);
});

test("a failed execution.start marks the markers failed", async () => {
	setupDocument("select 1");
	const store = createExecutionsStore(async <T>() => {
		throw new Error("connection refused") as T;
	});

	await store.getState().run("view-1", "auto");

	const markers = store.getState().statementMarkers["doc-1"];
	expect(markers).toHaveLength(1);
	expect(markers?.[0]).toMatchObject({
		status: "failed",
		message: "connection refused",
	});
});

test("cancellation marks non-succeeded statements cancelled", async () => {
	setupDocument("select 1;\nselect 22;");
	const store = createStore();
	await store.getState().run("view-1", "document");
	store
		.getState()
		.handleEvent(
			event("execution.progress", { statement: 1, command: "SELECT" }),
		);

	store.getState().handleEvent(event("execution.cancelled", { elapsedMs: 4 }));

	const markers = store.getState().statementMarkers["doc-1"];
	expect(markers?.map((marker) => marker.status)).toEqual([
		"succeeded",
		"cancelled",
	]);
});

test("reset clears statement markers", async () => {
	setupDocument("select 1");
	const store = createStore();
	await store.getState().run("view-1", "auto");
	expect(store.getState().statementMarkers["doc-1"]).toHaveLength(1);

	store.getState().reset();

	expect(store.getState().statementMarkers).toEqual({});
});
