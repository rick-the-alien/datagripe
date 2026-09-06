import { describe, expect, test } from "bun:test";
import type { TableColumn } from "@datagripe/contracts";
import {
	buildEdits,
	cellDetail,
	cellDisplay,
	isDirty,
	NO_PENDING_EDITS,
	pendingCount,
	rowKey,
	toCellInput,
	withCellEdit,
	withDeleteToggled,
	withInsertCellEdit,
	withNewRow,
	withoutInsert,
} from "./tableEdits";

const COLUMNS: TableColumn[] = [
	{
		name: "id",
		dataType: "integer",
		nullable: false,
		primaryKey: true,
		generated: false,
		hasDefault: true,
	},
	{
		name: "amount",
		dataType: "numeric",
		nullable: true,
		primaryKey: false,
		generated: false,
		hasDefault: false,
	},
	{
		name: "total",
		dataType: "numeric",
		nullable: true,
		primaryKey: false,
		generated: true,
		hasDefault: false,
	},
];

const ROWS: unknown[][] = [
	[1, "10.00", "10.00"],
	[2, null, null],
];

describe("cellDisplay", () => {
	test("null reads as NULL and is flagged", () => {
		expect(cellDisplay(null)).toEqual({ text: "NULL", isNull: true });
	});

	test("objects are compacted to JSON", () => {
		expect(cellDisplay({ a: 1 }).text).toBe('{"a":1}');
	});

	test("zero and false are values, not nulls", () => {
		expect(cellDisplay(0)).toEqual({ text: "0", isNull: false });
		expect(cellDisplay(false)).toEqual({ text: "false", isNull: false });
	});
});

describe("cellDetail", () => {
	test("pretty-prints JSON that arrived as text", () => {
		expect(cellDetail('{"a":1}')).toBe('{\n  "a": 1\n}');
	});

	test("leaves text that only looks like JSON alone", () => {
		expect(cellDetail("{not json")).toBe("{not json");
	});
});

describe("rowKey", () => {
	test("takes only the primary key, from the values as read", () => {
		expect(rowKey(COLUMNS, ROWS[0] as unknown[])).toEqual({
			id: { kind: "text", text: "1" },
		});
	});

	test("a null key value round-trips as a null input", () => {
		expect(toCellInput(null)).toEqual({ kind: "null" });
	});
});

describe("pending state", () => {
	test("an untouched grid is not dirty", () => {
		expect(isDirty(NO_PENDING_EDITS)).toBe(false);
		expect(pendingCount(NO_PENDING_EDITS)).toBe(0);
	});

	test("two cells in one row count as one pending edit", () => {
		let edits = withCellEdit(NO_PENDING_EDITS, 0, "amount", {
			kind: "text",
			text: "5",
		});
		edits = withCellEdit(edits, 0, "id", { kind: "text", text: "9" });
		expect(pendingCount(edits)).toBe(1);
	});

	test("deletes toggle off again", () => {
		const marked = withDeleteToggled(NO_PENDING_EDITS, 1);
		expect(marked.deletes).toEqual([1]);
		expect(withDeleteToggled(marked, 1).deletes).toEqual([]);
	});

	test("a new row starts every writable column at its default", () => {
		const edits = withNewRow(NO_PENDING_EDITS, COLUMNS);
		expect(edits.inserts[0]).toEqual({
			id: { kind: "default" },
			amount: { kind: "default" },
		});
	});

	test("a draft row can be discarded", () => {
		const edits = withNewRow(withNewRow(NO_PENDING_EDITS, COLUMNS), COLUMNS);
		expect(withoutInsert(edits, 0).inserts).toHaveLength(1);
	});
});

describe("buildEdits", () => {
	test("an update carries the key it was read with, not the edited key", () => {
		const edits = withCellEdit(NO_PENDING_EDITS, 0, "id", {
			kind: "text",
			text: "99",
		});
		expect(buildEdits(edits, COLUMNS, ROWS)).toEqual([
			{
				type: "update",
				key: { id: { kind: "text", text: "1" } },
				values: { id: { kind: "text", text: "99" } },
			},
		]);
	});

	test("deletes come last so an edited-then-deleted row cannot fail first", () => {
		let edits = withCellEdit(NO_PENDING_EDITS, 1, "amount", {
			kind: "text",
			text: "3",
		});
		edits = withNewRow(edits, COLUMNS);
		edits = withDeleteToggled(edits, 0);
		const list = buildEdits(edits, COLUMNS, ROWS);
		expect(list.map((edit) => edit.type)).toEqual([
			"update",
			"insert",
			"delete",
		]);
	});

	test("a row that is both edited and deleted only produces the delete", () => {
		let edits = withCellEdit(NO_PENDING_EDITS, 0, "amount", {
			kind: "text",
			text: "3",
		});
		edits = withDeleteToggled(edits, 0);
		expect(buildEdits(edits, COLUMNS, ROWS).map((edit) => edit.type)).toEqual([
			"delete",
		]);
	});

	test("an edit against a row index the page no longer has is dropped", () => {
		const edits = withCellEdit(NO_PENDING_EDITS, 9, "amount", {
			kind: "text",
			text: "3",
		});
		expect(buildEdits(edits, COLUMNS, ROWS)).toEqual([]);
	});

	test("insert cell edits replace the column's default", () => {
		let edits = withNewRow(NO_PENDING_EDITS, COLUMNS);
		edits = withInsertCellEdit(edits, 0, "amount", {
			kind: "text",
			text: "7.50",
		});
		expect(buildEdits(edits, COLUMNS, ROWS)).toEqual([
			{
				type: "insert",
				values: {
					id: { kind: "default" },
					amount: { kind: "text", text: "7.50" },
				},
			},
		]);
	});
});
