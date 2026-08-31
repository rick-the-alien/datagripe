import { expect, test } from "bun:test";
import type { ServerEvent } from "@datagripe/contracts/ws";
import { registerEditorHandle } from "../editor/handles";
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
