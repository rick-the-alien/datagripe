import { z } from "zod";

/**
 * Table view contracts (docs/spec/table-view.md): browsing and editing
 * one relation's rows, independent of the SQL editor's execution path.
 *
 * The grid is a text surface, so every value the client writes travels
 * as a tagged cell input rather than a JSON scalar — `NULL`, "use the
 * column default" and "the empty string" are three different intents
 * that JSON alone cannot tell apart. Text is bound as a query parameter
 * and cast by the target database.
 */

export const cellInputSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("null") }),
	z.object({ kind: z.literal("default") }),
	z.object({ kind: z.literal("text"), text: z.string().max(1_000_000) }),
]);

export type CellInput = z.infer<typeof cellInputSchema>;

export const tableColumnSchema = z.object({
	name: z.string(),
	dataType: z.string(),
	nullable: z.boolean(),
	primaryKey: z.boolean(),
	/** Identity/generated columns are read-only even on a writable table. */
	generated: z.boolean(),
	/** True when omitting the column on insert produces a value. */
	hasDefault: z.boolean(),
});

export type TableColumn = z.infer<typeof tableColumnSchema>;

export const tableSortSchema = z.object({
	column: z.string().min(1).max(255),
	direction: z.enum(["asc", "desc"]),
});

export type TableSort = z.infer<typeof tableSortSchema>;

/** Server-side page cap; the client's row-limit menu stays well below it. */
export const TABLE_PAGE_MAX_ROWS = 5_000;

export const tableRowsRequestSchema = z.object({
	/** Managed UUID or predefined slug. */
	connectionId: z.string().min(1).max(255),
	/** Namespace as the tree shows it (schema / database / attached file). */
	schema: z.string().min(1).max(255),
	table: z.string().min(1).max(255),
	kind: z.enum(["table", "view"]).default("table"),
	limit: z.number().int().min(1).max(TABLE_PAGE_MAX_ROWS).default(100),
	offset: z.number().int().min(0).max(1_000_000_000).default(0),
	sort: z.array(tableSortSchema).max(8).default([]),
	/**
	 * Raw predicate spliced into WHERE — the `where …` box from the brand
	 * spec. Read under a read-only transaction with a statement timeout,
	 * and rejected outright if it tries to stack statements.
	 */
	filter: z.string().max(2_000).default(""),
	/** Include the (possibly estimated) total row count. */
	count: z.boolean().default(true),
});

export type TableRowsRequest = z.infer<typeof tableRowsRequestSchema>;

export const tableRowsResultSchema = z.object({
	columns: z.array(tableColumnSchema),
	rows: z.array(z.array(z.unknown())),
	offset: z.number().int(),
	limit: z.number().int(),
	/** null when the count was not requested or could not be taken. */
	totalRows: z.number().int().nullable(),
	/** True when totalRows came from planner statistics, not COUNT(*). */
	estimated: z.boolean(),
	/** False when the grid must stay read-only; `reason` says why. */
	editable: z.boolean(),
	reason: z.string().max(500).optional(),
});

export type TableRowsResult = z.infer<typeof tableRowsResultSchema>;

const cellMapSchema = z.record(z.string().min(1).max(255), cellInputSchema);

/**
 * One pending grid edit. `key` always carries the full primary key of
 * the row as it was read, so the server can both locate the row and
 * refuse anything that is not a single-row write.
 */
export const tableEditSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("insert"), values: cellMapSchema }),
	z.object({
		type: z.literal("update"),
		key: cellMapSchema,
		values: cellMapSchema,
	}),
	z.object({ type: z.literal("delete"), key: cellMapSchema }),
]);

export type TableEdit = z.infer<typeof tableEditSchema>;

export const tableMutateRequestSchema = z.object({
	connectionId: z.string().min(1).max(255),
	schema: z.string().min(1).max(255),
	table: z.string().min(1).max(255),
	edits: z.array(tableEditSchema).min(1).max(500),
	idempotencyKey: z.string().min(8).max(128),
});

export type TableMutateRequest = z.infer<typeof tableMutateRequestSchema>;

export const tableMutateResultSchema = z.object({
	/** Statements that reported exactly one affected row. */
	applied: z.number().int(),
});

export type TableMutateResult = z.infer<typeof tableMutateResultSchema>;
