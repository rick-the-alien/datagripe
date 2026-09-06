import type {
	ColumnChange,
	ColumnChangeKind,
	ObjectColumn,
} from "@datagripe/contracts";

/**
 * Pending column changes for the object view's columns tab
 * (docs/spec/object-view.md "Editing columns"). Kept out of the
 * component so turning a scatter of edited fields into a minimal,
 * correctly ordered change list is testable without a DOM.
 *
 * Columns are addressed by their original name, which is stable for the
 * life of the pending set — a rename is recorded as a change rather than
 * applied to the key.
 */

/** The editable attributes of an existing column. */
export interface ColumnPatch {
	name?: string;
	dataType?: string;
	nullable?: boolean;
	/** null means "drop the default"; undefined means "untouched". */
	defaultExpr?: string | null;
	comment?: string | null;
}

/** A column that does not exist yet. */
export interface DraftColumn {
	name: string;
	dataType: string;
	nullable: boolean;
	defaultExpr: string | null;
	comment: string | null;
}

export interface PendingColumns {
	/** original column name → the attributes being changed. */
	patches: Record<string, ColumnPatch>;
	/** Original column names marked for dropping. */
	drops: string[];
	/** New columns, in the order they were added. */
	drafts: DraftColumn[];
}

export const NO_PENDING_COLUMNS: PendingColumns = {
	patches: {},
	drops: [],
	drafts: [],
};

export function newDraft(): DraftColumn {
	return {
		name: "",
		dataType: "",
		nullable: true,
		defaultExpr: null,
		comment: null,
	};
}

export function pendingColumnCount(pending: PendingColumns): number {
	return (
		Object.keys(pending.patches).length +
		pending.drops.length +
		pending.drafts.length
	);
}

export function isColumnsDirty(pending: PendingColumns): boolean {
	return pendingColumnCount(pending) > 0;
}

export function withPatch(
	pending: PendingColumns,
	name: string,
	patch: ColumnPatch,
): PendingColumns {
	return {
		...pending,
		patches: {
			...pending.patches,
			[name]: { ...pending.patches[name], ...patch },
		},
	};
}

export function withDropToggled(
	pending: PendingColumns,
	name: string,
): PendingColumns {
	const marked = pending.drops.includes(name);
	return {
		...pending,
		drops: marked
			? pending.drops.filter((entry) => entry !== name)
			: [...pending.drops, name],
	};
}

export function withDraft(pending: PendingColumns): PendingColumns {
	return { ...pending, drafts: [...pending.drafts, newDraft()] };
}

export function withDraftPatch(
	pending: PendingColumns,
	index: number,
	patch: Partial<DraftColumn>,
): PendingColumns {
	return {
		...pending,
		drafts: pending.drafts.map((draft, position) =>
			position === index ? { ...draft, ...patch } : draft,
		),
	};
}

export function withoutDraft(
	pending: PendingColumns,
	index: number,
): PendingColumns {
	return {
		...pending,
		drafts: pending.drafts.filter((_draft, position) => position !== index),
	};
}

/** The value a cell shows: the pending one if touched, else the current. */
export function patchedValue<K extends keyof DraftColumn>(
	pending: PendingColumns,
	column: ObjectColumn,
	field: K,
): DraftColumn[K] {
	const patch = pending.patches[column.name];
	if (patch !== undefined && field in patch) {
		return patch[field as keyof ColumnPatch] as DraftColumn[K];
	}
	return column[field as keyof ObjectColumn] as DraftColumn[K];
}

/** A draft with no name or no type cannot become a column. */
export function draftProblem(draft: DraftColumn): string | null {
	if (draft.name.trim() === "") {
		return "a new column needs a name";
	}
	if (draft.dataType.trim() === "") {
		return "a new column needs a type";
	}
	return null;
}

/**
 * The wire form of the pending set.
 *
 * Order matters and is fixed here rather than left to the caller:
 * attribute changes first, then adds, then renames, then drops. A rename
 * invalidates the name every other change refers to, so it goes after
 * them; a drop makes the column unreachable, so it goes last.
 */
export function buildColumnChanges(
	pending: PendingColumns,
	columns: ObjectColumn[],
): ColumnChange[] {
	const dropped = new Set(pending.drops);
	const attributes: ColumnChange[] = [];
	const renames: ColumnChange[] = [];

	for (const column of columns) {
		const patch = pending.patches[column.name];
		// A column being dropped needs none of its edits applied first.
		if (patch === undefined || dropped.has(column.name)) {
			continue;
		}
		if (patch.dataType !== undefined && patch.dataType !== column.dataType) {
			attributes.push({
				type: "setType",
				name: column.name,
				dataType: patch.dataType,
			});
		}
		if (patch.nullable !== undefined && patch.nullable !== column.nullable) {
			attributes.push({
				type: "setNullable",
				name: column.name,
				nullable: patch.nullable,
			});
		}
		if (
			patch.defaultExpr !== undefined &&
			patch.defaultExpr !== column.defaultExpr
		) {
			attributes.push({
				type: "setDefault",
				name: column.name,
				defaultExpr: patch.defaultExpr,
			});
		}
		if (patch.comment !== undefined && patch.comment !== column.comment) {
			attributes.push({
				type: "setComment",
				name: column.name,
				comment: patch.comment,
			});
		}
		if (
			patch.name !== undefined &&
			patch.name.trim() !== "" &&
			patch.name !== column.name
		) {
			renames.push({
				type: "rename",
				name: column.name,
				newName: patch.name.trim(),
			});
		}
	}

	const adds: ColumnChange[] = [];
	for (const draft of pending.drafts) {
		if (draftProblem(draft) !== null) {
			continue;
		}
		adds.push({
			type: "add",
			name: draft.name.trim(),
			dataType: draft.dataType.trim(),
			nullable: draft.nullable,
			defaultExpr: draft.defaultExpr,
			comment: draft.comment,
		});
	}

	const drops: ColumnChange[] = pending.drops
		.filter((name) => columns.some((column) => column.name === name))
		.map((name) => ({ type: "drop", name }));

	return [...attributes, ...adds, ...renames, ...drops];
}

/** Which change kinds a pending set needs, for capability gating. */
export function requiredChangeKinds(
	changes: ColumnChange[],
): ColumnChangeKind[] {
	return [...new Set(changes.map((change) => change.type))];
}
