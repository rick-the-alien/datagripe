import type { ExecutionSink } from "../types";

/**
 * Shared row emission with server-enforced caps (docs/spec/query-execution.md):
 * value normalization (JSON-safe), row/byte limits with truncation, and
 * sink dispatch. Used by every SQL dialect's execution path.
 */

export interface RunState {
	rowCount: number;
	bytes: number;
	truncated: boolean;
}

/** JSON-safe, size-bounded value normalization for the wire. */
export function normalizeValue(value: unknown): unknown {
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof Uint8Array) {
		return `\\x${Buffer.from(value).toString("hex")}`;
	}
	return value;
}

export function emitRows(
	limits: { maxRows: number; maxBytes: number },
	state: RunState,
	resultSet: number,
	records: Array<Record<string, unknown>>,
	offset: number,
	sink: ExecutionSink,
): void {
	if (records.length === 0) {
		return;
	}
	const columns = Object.keys(records[0] as Record<string, unknown>);
	const fitted: unknown[][] = [];
	for (const record of records) {
		if (state.rowCount + fitted.length >= limits.maxRows) {
			state.truncated = true;
			break;
		}
		const row = columns.map((column) => normalizeValue(record[column]));
		const size = JSON.stringify(row).length;
		if (state.bytes + size > limits.maxBytes) {
			state.truncated = true;
			break;
		}
		state.bytes += size;
		fitted.push(row);
	}
	if (fitted.length > 0) {
		sink.rows(resultSet, fitted, offset);
		state.rowCount += fitted.length;
	}
}
