import { describe, expect, test } from "bun:test";
import type { ObjectColumn } from "@datagripe/contracts";
import {
	buildColumnChanges,
	draftProblem,
	isColumnsDirty,
	NO_PENDING_COLUMNS,
	newDraft,
	patchedValue,
	pendingColumnCount,
	requiredChangeKinds,
	withDraft,
	withDraftPatch,
	withDropToggled,
	withoutDraft,
	withPatch,
} from "./columnEdits";

function column(
	name: string,
	overrides: Partial<ObjectColumn> = {},
): ObjectColumn {
	return {
		name,
		dataType: "text",
		nullable: true,
		defaultExpr: null,
		primaryKey: false,
		comment: null,
		...overrides,
	};
}

const COLUMNS: ObjectColumn[] = [
	column("id", { dataType: "integer", nullable: false, primaryKey: true }),
	column("status", { defaultExpr: "'new'", comment: "Order state" }),
	column("amount", { dataType: "numeric(10,2)", nullable: false }),
];

describe("pending state", () => {
	test("an untouched tab is not dirty", () => {
		expect(isColumnsDirty(NO_PENDING_COLUMNS)).toBe(false);
		expect(pendingColumnCount(NO_PENDING_COLUMNS)).toBe(0);
	});

	test("several fields on one column count as one pending change", () => {
		let pending = withPatch(NO_PENDING_COLUMNS, "status", {
			dataType: "varchar(32)",
		});
		pending = withPatch(pending, "status", { nullable: false });
		expect(pendingColumnCount(pending)).toBe(1);
	});

	test("drops toggle off again", () => {
		const marked = withDropToggled(NO_PENDING_COLUMNS, "status");
		expect(marked.drops).toEqual(["status"]);
		expect(withDropToggled(marked, "status").drops).toEqual([]);
	});

	test("drafts add and discard", () => {
		const pending = withDraft(withDraft(NO_PENDING_COLUMNS));
		expect(pending.drafts).toHaveLength(2);
		expect(withoutDraft(pending, 0).drafts).toHaveLength(1);
	});
});

describe("patchedValue", () => {
	test("falls back to the column until the field is touched", () => {
		const target = COLUMNS[1] as ObjectColumn;
		expect(patchedValue(NO_PENDING_COLUMNS, target, "dataType")).toBe("text");
		const pending = withPatch(NO_PENDING_COLUMNS, "status", {
			dataType: "varchar(32)",
		});
		expect(patchedValue(pending, target, "dataType")).toBe("varchar(32)");
	});

	test("a default cleared to null reads as null, not as the old value", () => {
		const target = COLUMNS[1] as ObjectColumn;
		const pending = withPatch(NO_PENDING_COLUMNS, "status", {
			defaultExpr: null,
		});
		expect(patchedValue(pending, target, "defaultExpr")).toBeNull();
	});
});

describe("draftProblem", () => {
	test("a draft needs both a name and a type", () => {
		expect(draftProblem(newDraft())).toMatch(/name/);
		expect(draftProblem({ ...newDraft(), name: "note" })).toMatch(/type/);
		expect(
			draftProblem({ ...newDraft(), name: "note", dataType: "text" }),
		).toBeNull();
	});
});

describe("buildColumnChanges", () => {
	test("only changed fields become changes", () => {
		// Setting a field back to what it already was is not a change.
		const pending = withPatch(NO_PENDING_COLUMNS, "status", {
			dataType: "text",
			nullable: true,
			comment: "Something else",
		});
		expect(buildColumnChanges(pending, COLUMNS)).toEqual([
			{ type: "setComment", name: "status", comment: "Something else" },
		]);
	});

	test("attributes, then adds, then renames, then drops", () => {
		// A rename invalidates the name the other changes use, and a drop
		// makes the column unreachable, so both go after the rest.
		let pending = withPatch(NO_PENDING_COLUMNS, "status", {
			nullable: false,
			name: "state",
		});
		pending = withDraftPatch(withDraft(pending), 0, {
			name: "note",
			dataType: "text",
		});
		pending = withDropToggled(pending, "amount");
		expect(buildColumnChanges(pending, COLUMNS).map((c) => c.type)).toEqual([
			"setNullable",
			"add",
			"rename",
			"drop",
		]);
	});

	test("a column that is edited and dropped only produces the drop", () => {
		let pending = withPatch(NO_PENDING_COLUMNS, "status", {
			dataType: "varchar(8)",
		});
		pending = withDropToggled(pending, "status");
		expect(buildColumnChanges(pending, COLUMNS)).toEqual([
			{ type: "drop", name: "status" },
		]);
	});

	test("an incomplete draft is left out rather than sent", () => {
		const pending = withDraftPatch(withDraft(NO_PENDING_COLUMNS), 0, {
			name: "note",
		});
		expect(buildColumnChanges(pending, COLUMNS)).toEqual([]);
	});

	test("a draft's name and type are trimmed", () => {
		const pending = withDraftPatch(withDraft(NO_PENDING_COLUMNS), 0, {
			name: "  note  ",
			dataType: "  text  ",
		});
		expect(buildColumnChanges(pending, COLUMNS)).toEqual([
			{
				type: "add",
				name: "note",
				dataType: "text",
				nullable: true,
				defaultExpr: null,
				comment: null,
			},
		]);
	});

	test("a rename to whitespace is ignored, not sent as empty", () => {
		const pending = withPatch(NO_PENDING_COLUMNS, "status", { name: "   " });
		expect(buildColumnChanges(pending, COLUMNS)).toEqual([]);
	});

	test("an edit against a column the object no longer has is dropped", () => {
		const pending = withPatch(NO_PENDING_COLUMNS, "ghost", {
			dataType: "text",
		});
		expect(buildColumnChanges(pending, COLUMNS)).toEqual([]);
	});

	test("dropping a column that is gone is not sent", () => {
		const pending = withDropToggled(NO_PENDING_COLUMNS, "ghost");
		expect(buildColumnChanges(pending, COLUMNS)).toEqual([]);
	});

	test("clearing a default sends null rather than an empty string", () => {
		const pending = withPatch(NO_PENDING_COLUMNS, "status", {
			defaultExpr: null,
		});
		expect(buildColumnChanges(pending, COLUMNS)).toEqual([
			{ type: "setDefault", name: "status", defaultExpr: null },
		]);
	});
});

describe("requiredChangeKinds", () => {
	test("reports each kind once, for capability gating", () => {
		let pending = withPatch(NO_PENDING_COLUMNS, "status", {
			dataType: "varchar(8)",
		});
		pending = withPatch(pending, "amount", { dataType: "numeric(12,2)" });
		pending = withDropToggled(pending, "id");
		const kinds = requiredChangeKinds(buildColumnChanges(pending, COLUMNS));
		expect(kinds.sort()).toEqual(["drop", "setType"]);
	});
});
