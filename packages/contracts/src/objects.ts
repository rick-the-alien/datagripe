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
	"arguments",
	"indexes",
	"constraints",
	"triggers",
	"grants",
	"statistics",
	"ddl",
]);

export type ObjectTab = z.infer<typeof objectTabSchema>;

/** Tab order for a relation. */
export const RELATION_TABS: ObjectTab[] = [
	"columns",
	"indexes",
	"constraints",
	"triggers",
	"grants",
	"statistics",
	"ddl",
];

/** Tab order for a routine — no columns, no indexes, no triggers. */
export const ROUTINE_TABS: ObjectTab[] = [
	"arguments",
	"grants",
	"statistics",
	"ddl",
];

/** Tab order for a sequence: it is a counter with a definition. */
export const SEQUENCE_TABS: ObjectTab[] = ["statistics", "ddl"];

/** Kinds of object the object view can describe. */
export const objectKindSchema = z.enum([
	"table",
	"view",
	"function",
	"procedure",
	"sequence",
]);

export type ObjectKind = z.infer<typeof objectKindSchema>;

export function tabsForKind(kind: ObjectKind): ObjectTab[] {
	switch (kind) {
		case "function":
		case "procedure":
			return ROUTINE_TABS;
		case "sequence":
			return SEQUENCE_TABS;
		default:
			return RELATION_TABS;
	}
}

/** Relations have rows; routines and sequences do not. */
export function isRelationKind(kind: ObjectKind): kind is "table" | "view" {
	return kind === "table" || kind === "view";
}

export const objectDescribeRequestSchema = z.object({
	/** Managed UUID or predefined slug. */
	connectionId: z.string().min(1).max(255),
	/** Namespace as the tree shows it (schema / database / attached file). */
	schema: z.string().min(1).max(255),
	/**
	 * As the tree shows it. A PostgreSQL routine's name carries its
	 * identity arguments — `f(integer, text)` — which is what keeps
	 * overloads distinct.
	 */
	name: z.string().min(1).max(1024),
	kind: objectKindSchema.default("table"),
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

/** One routine parameter. */
export const objectArgumentSchema = z.object({
	name: z.string(),
	dataType: z.string(),
	/** in / out / inout / variadic / table. */
	mode: z.string(),
});

export type ObjectArgument = z.infer<typeof objectArgumentSchema>;

/** An object that a DROP would take with it, for the danger zone. */
export const objectDependentSchema = z.object({
	kind: z.string(),
	name: z.string(),
});

export type ObjectDependent = z.infer<typeof objectDependentSchema>;

export const objectDescribeResultSchema = z.object({
	schema: z.string(),
	name: z.string(),
	kind: objectKindSchema,
	/** Tabs this kind of object has at all, in strip order. */
	tabs: z.array(objectTabSchema),
	/** Header row count; null when the engine has no cheap answer. */
	rowEstimate: z.number().nullable(),
	/** True when rowEstimate came from planner statistics. */
	estimated: z.boolean(),
	columns: z.array(objectColumnSchema),
	arguments: z.array(objectArgumentSchema),
	indexes: z.array(objectIndexSchema),
	constraints: z.array(objectConstraintSchema),
	triggers: z.array(objectTriggerSchema),
	grants: z.array(objectGrantSchema),
	statistics: z.array(objectStatisticSchema),
	ddl: z.string().nullable(),
	/**
	 * Of the tabs this object has, the ones this engine cannot answer —
	 * SQLite has no grants, for instance. An empty tab and an
	 * unanswerable tab look identical otherwise, and the difference
	 * matters. Tabs a kind does not have at all are simply absent from
	 * `tabs`, which is a third and different thing.
	 */
	unsupported: z.array(objectTabSchema),
	/** True when `ddl` was rebuilt from the catalog rather than reported
	 * verbatim by the server. */
	ddlReconstructed: z.boolean(),
	dependents: z.array(objectDependentSchema),
});

export type ObjectDescribeResult = z.infer<typeof objectDescribeResultSchema>;
