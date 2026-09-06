import type { CellInput, TableColumn, TableEdit } from "@datagripe/contracts";

/**
 * Pending grid edits (docs/spec/table-view.md). Kept out of the
 * component so the interesting part — turning a scatter of touched cells
 * into a minimal, ordered edit list — is testable without a DOM.
 *
 * Rows are addressed by their index in the page that was fetched. A
 * refresh throws the whole pending state away, because index 4 after a
 * re-sort is a different row.
 */

export interface PendingEdits {
	/** page row index → column name → new value. */
	updates: Record<number, Record<string, CellInput>>;
	/** Page row indexes marked for deletion. */
	deletes: number[];
	/** Draft rows, in the order they were added. */
	inserts: Array<Record<string, CellInput>>;
}

export const NO_PENDING_EDITS: PendingEdits = {
	updates: {},
	deletes: [],
	inserts: [],
};

/** The text a cell shows, and whether it is SQL NULL. */
export function cellDisplay(value: unknown): {
	text: string;
	isNull: boolean;
} {
	if (value === null || value === undefined) {
		return { text: "NULL", isNull: true };
	}
	if (typeof value === "object") {
		return { text: JSON.stringify(value), isNull: false };
	}
	return { text: String(value), isNull: false };
}

/** The value the side panel shows, pretty-printed when it is JSON. */
export function cellDetail(value: unknown): string {
	if (value === null || value === undefined) {
		return "NULL";
	}
	if (typeof value === "object") {
		return JSON.stringify(value, null, 2);
	}
	const text = String(value);
	// A jsonb column often arrives as text; format it if it really is JSON.
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return JSON.stringify(JSON.parse(trimmed), null, 2);
		} catch {
			return text;
		}
	}
	return text;
}

/** The cell input that reproduces a value the server sent us. */
export function toCellInput(value: unknown): CellInput {
	if (value === null || value === undefined) {
		return { kind: "null" };
	}
	return { kind: "text", text: cellDisplay(value).text };
}

export function primaryKeyColumns(columns: TableColumn[]): TableColumn[] {
	return columns.filter((column) => column.primaryKey);
}

/**
 * A row's identity, taken from the values as they were read — never from
 * a pending edit, or changing a primary key would address the row it is
 * about to become.
 */
export function rowKey(
	columns: TableColumn[],
	row: unknown[],
): Record<string, CellInput> {
	const key: Record<string, CellInput> = {};
	for (const [index, column] of columns.entries()) {
		if (column.primaryKey) {
			key[column.name] = toCellInput(row[index]);
		}
	}
	return key;
}

export function pendingCount(edits: PendingEdits): number {
	return (
		Object.keys(edits.updates).length +
		edits.deletes.length +
		edits.inserts.length
	);
}

export function isDirty(edits: PendingEdits): boolean {
	return pendingCount(edits) > 0;
}

/** The pending value of one cell, or undefined when it is untouched. */
export function pendingCell(
	edits: PendingEdits,
	rowIndex: number,
	column: string,
): CellInput | undefined {
	return edits.updates[rowIndex]?.[column];
}

export function withCellEdit(
	edits: PendingEdits,
	rowIndex: number,
	column: string,
	value: CellInput,
): PendingEdits {
	return {
		...edits,
		updates: {
			...edits.updates,
			[rowIndex]: { ...edits.updates[rowIndex], [column]: value },
		},
	};
}

export function withInsertCellEdit(
	edits: PendingEdits,
	insertIndex: number,
	column: string,
	value: CellInput,
): PendingEdits {
	return {
		...edits,
		inserts: edits.inserts.map((row, index) =>
			index === insertIndex ? { ...row, [column]: value } : row,
		),
	};
}

export function withDeleteToggled(
	edits: PendingEdits,
	rowIndex: number,
): PendingEdits {
	const marked = edits.deletes.includes(rowIndex);
	return {
		...edits,
		deletes: marked
			? edits.deletes.filter((index) => index !== rowIndex)
			: [...edits.deletes, rowIndex],
	};
}

/**
 * A new draft row starts with every writable column at its default, so
 * committing an untouched draft inserts a defaults-only row rather than
 * a wall of empty strings.
 */
export function withNewRow(
	edits: PendingEdits,
	columns: TableColumn[],
): PendingEdits {
	const row: Record<string, CellInput> = {};
	for (const column of columns) {
		if (!column.generated) {
			row[column.name] = { kind: "default" };
		}
	}
	return { ...edits, inserts: [...edits.inserts, row] };
}

export function withoutInsert(
	edits: PendingEdits,
	insertIndex: number,
): PendingEdits {
	return {
		...edits,
		inserts: edits.inserts.filter((_row, index) => index !== insertIndex),
	};
}

/**
 * The wire form of the pending state. Deletes go last so a row that was
 * edited and then deleted in the same batch does not fail its update
 * against a row that no longer exists.
 */
export function buildEdits(
	edits: PendingEdits,
	columns: TableColumn[],
	rows: unknown[][],
): TableEdit[] {
	const deleted = new Set(edits.deletes);
	const list: TableEdit[] = [];

	for (const [rowIndex, values] of Object.entries(edits.updates)) {
		const index = Number(rowIndex);
		const row = rows[index];
		// A row that is also being deleted needs no update, and a row that
		// vanished from the page cannot be addressed.
		if (row === undefined || deleted.has(index)) {
			continue;
		}
		if (Object.keys(values).length === 0) {
			continue;
		}
		list.push({ type: "update", key: rowKey(columns, row), values });
	}

	for (const values of edits.inserts) {
		list.push({ type: "insert", values });
	}

	for (const index of edits.deletes) {
		const row = rows[index];
		if (row !== undefined) {
			list.push({ type: "delete", key: rowKey(columns, row) });
		}
	}

	return list;
}
