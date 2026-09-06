import { z } from "zod";

/**
 * Object view contracts (docs/spec/object-view.md): the structure of one
 * relation, in the shape the tab strip renders.
 *
 * There is deliberately no data here — rows are the table view's job
 * (docs/spec/table-view.md). One `object.describe` call fills every tab,
 * because the tabs are cheap catalog reads and a per-tab round trip
 * would make switching tabs feel like loading a page.
 */

export const objectTabSchema = z.enum([
	"columns",
	"indexes",
	"constraints",
	"triggers",
	"grants",
	"statistics",
	"ddl",
]);

export type ObjectTab = z.infer<typeof objectTabSchema>;

export const OBJECT_TABS: ObjectTab[] = [
	"columns",
	"indexes",
	"constraints",
	"triggers",
	"grants",
	"statistics",
	"ddl",
];

export const objectDescribeRequestSchema = z.object({
	/** Managed UUID or predefined slug. */
	connectionId: z.string().min(1).max(255),
	/** Namespace as the tree shows it (schema / database / attached file). */
	schema: z.string().min(1).max(255),
	name: z.string().min(1).max(255),
	kind: z.enum(["table", "view"]).default("table"),
});

export type ObjectDescribeRequest = z.infer<typeof objectDescribeRequestSchema>;

export const objectColumnSchema = z.object({
	name: z.string(),
	dataType: z.string(),
	nullable: z.boolean(),
	/** Rendered as-is; null means no default. */
	defaultExpr: z.string().nullable(),
	primaryKey: z.boolean(),
	comment: z.string().nullable(),
});

export type ObjectColumn = z.infer<typeof objectColumnSchema>;

export const objectIndexSchema = z.object({
	name: z.string(),
	/** btree / hash / gin … or the engine's own word for it. */
	method: z.string(),
	/** Key columns as the engine expresses them, including sort order. */
	columns: z.string(),
	unique: z.boolean(),
	primary: z.boolean(),
	/** null when the engine cannot size an index. */
	sizeBytes: z.number().nullable(),
});

export type ObjectIndex = z.infer<typeof objectIndexSchema>;

export const objectConstraintSchema = z.object({
	name: z.string(),
	/** primary key / foreign key / unique / check … */
	type: z.string(),
	definition: z.string(),
});

export type ObjectConstraint = z.infer<typeof objectConstraintSchema>;

export const objectTriggerSchema = z.object({
	name: z.string(),
	/** before / after / instead of. */
	timing: z.string(),
	/** insert, update, delete — comma-joined when a trigger covers several. */
	events: z.string(),
	/** The function or statement the trigger runs. */
	action: z.string(),
	enabled: z.boolean(),
});

export type ObjectTrigger = z.infer<typeof objectTriggerSchema>;

export const objectGrantSchema = z.object({
	grantee: z.string(),
	/** Privileges comma-joined, lower-cased. */
	privileges: z.string(),
	grantor: z.string().nullable(),
});

export type ObjectGrant = z.infer<typeof objectGrantSchema>;

/**
 * A statistics tile. Engines disagree about which numbers exist at all,
 * so this is a label/value list rather than a fixed struct — each
 * adapter reports what it actually has instead of padding with nulls.
 */
export const objectStatisticSchema = z.object({
	label: z.string(),
	value: z.string(),
});

export type ObjectStatistic = z.infer<typeof objectStatisticSchema>;

/** An object that a DROP would take with it, for the danger zone. */
export const objectDependentSchema = z.object({
	kind: z.string(),
	name: z.string(),
});

export type ObjectDependent = z.infer<typeof objectDependentSchema>;

export const objectDescribeResultSchema = z.object({
	schema: z.string(),
	name: z.string(),
	kind: z.enum(["table", "view"]),
	/** Header row count; null when the engine has no cheap answer. */
	rowEstimate: z.number().nullable(),
	/** True when rowEstimate came from planner statistics. */
	estimated: z.boolean(),
	columns: z.array(objectColumnSchema),
	indexes: z.array(objectIndexSchema),
	constraints: z.array(objectConstraintSchema),
	triggers: z.array(objectTriggerSchema),
	grants: z.array(objectGrantSchema),
	statistics: z.array(objectStatisticSchema),
	ddl: z.string().nullable(),
	/**
	 * Tabs this engine cannot answer at all — SQLite has no grants, for
	 * instance. An empty tab and an unanswerable tab look identical
	 * otherwise, and the difference matters.
	 */
	unsupported: z.array(objectTabSchema),
	/** True when `ddl` was rebuilt from the catalog rather than reported
	 * verbatim by the server. */
	ddlReconstructed: z.boolean(),
	dependents: z.array(objectDependentSchema),
});

export type ObjectDescribeResult = z.infer<typeof objectDescribeResultSchema>;
