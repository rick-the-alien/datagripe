import { ADAPTER_CAPABILITIES } from "@datagripe/contracts";
import type { SqlDialect } from "@datagripe/sql-tools";
import { useDocumentsStore } from "./documents";
import { refToConnectionId } from "./executions";
import { useConnectionsStore } from "./runtime";
import { useSessionStore } from "./session";

/**
 * Which connection a document's SQL is written against.
 *
 * Shared rather than duplicated because completion and the gripe runner
 * must agree: completion offering columns from one connection while a
 * gripe rule asks another about nullability would produce findings that
 * contradict the suggestions that led to them.
 *
 * Read synchronously from store state, not through hooks, so callers
 * inside Monaco providers and store internals can use it too.
 */
export function connectionIdForDocument(
	documentId: string | undefined,
): string | undefined {
	if (documentId === undefined) {
		return undefined;
	}
	return (
		useDocumentsStore.getState().prefs[documentId]?.defaultConnectionId ??
		refToConnectionId(
			useSessionStore.getState().currentWorkspace?.defaultConnectionRef ?? null,
		)
	);
}

/**
 * The dialect to tokenize a document's SQL as.
 *
 * Taken from the adapter's `sqlDialect` capability, never from the
 * adapter id — the two only coincide today, and a rule that applies to
 * one engine and not another has to be able to trust this. Falls back
 * to Postgres when the connection is unknown, which is what the
 * splitter did before any of this was resolved at all.
 */
export function dialectForConnection(
	connectionId: string | undefined,
): SqlDialect {
	if (connectionId === undefined) {
		return "postgres";
	}
	const connection = useConnectionsStore
		.getState()
		.connections.find((candidate) => candidate.id === connectionId);
	if (connection === undefined) {
		return "postgres";
	}
	return ADAPTER_CAPABILITIES[connection.adapter].sqlDialect ?? "postgres";
}
