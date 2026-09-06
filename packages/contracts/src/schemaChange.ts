import { z } from "zod";

/**
 * Column-level schema change (docs/spec/object-view.md "Editing
 * columns"). The object view's columns tab edits into a pending set,
 * then asks the server what SQL that would be, shows it, and only then
 * applies it.
 *
 * One action serves both steps — `dryRun` returns the statements without
 * running them — so the SQL you approve cannot drift from the SQL that
 * executes.
 */

/**
 * A type name, not an expression. Kept to a shape no dialect can read as
 * anything but a type: letters, digits, spaces and underscores, an
 * optional precision, an optional array suffix. That rules out quotes,
 * semicolons and function calls, which is what makes it safe to splice
 * into DDL where no engine accepts a bind parameter.
 */
export const dataTypeSchema = z
	.string()
	.min(1)
	.max(120)
	.regex(
		/^[A-Za-z][A-Za-z0-9_ ]*(\(\d{1,4}(\s*,\s*\d{1,4})?\))?(\s*\[\s*\])?$/,
		"Enter a plain type name, optionally with a precision",
	);

/** An identifier the client supplies for a new or renamed column. */
export const columnNameSchema = z.string().min(1).max(255);

/**
 * A default is a real expression (`now()`, `'pending'`, `0`), so it
 * cannot be allowlisted the way a type can. It is checked for statement
 * stacking instead, the same way the table view's `where …` box is.
 */
export const defaultExpressionSchema = z.string().max(2_000);

export const columnChangeSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("add"),
		name: columnNameSchema,
		dataType: dataTypeSchema,
		nullable: z.boolean().default(true),
		defaultExpr: defaultExpressionSchema.nullable().default(null),
		comment: z.string().max(2_000).nullable().default(null),
	}),
	z.object({
		type: z.literal("rename"),
		name: columnNameSchema,
		newName: columnNameSchema,
	}),
	z.object({
		type: z.literal("setType"),
		name: columnNameSchema,
		dataType: dataTypeSchema,
	}),
	z.object({
		type: z.literal("setNullable"),
		name: columnNameSchema,
		nullable: z.boolean(),
	}),
	z.object({
		type: z.literal("setDefault"),
		name: columnNameSchema,
		/** null drops the default. */
		defaultExpr: defaultExpressionSchema.nullable(),
	}),
	z.object({
		type: z.literal("setComment"),
		name: columnNameSchema,
		comment: z.string().max(2_000).nullable(),
	}),
	z.object({ type: z.literal("drop"), name: columnNameSchema }),
]);

export type ColumnChange = z.infer<typeof columnChangeSchema>;

export const columnChangeKindSchema = z.enum([
	"add",
	"rename",
	"setType",
	"setNullable",
	"setDefault",
	"setComment",
	"drop",
]);

export type ColumnChangeKind = z.infer<typeof columnChangeKindSchema>;

export const objectAlterRequestSchema = z.object({
	connectionId: z.string().min(1).max(255),
	schema: z.string().min(1).max(255),
	name: z.string().min(1).max(255),
	changes: z.array(columnChangeSchema).min(1).max(50),
	/** Return the statements without running them — the preview step. */
	dryRun: z.boolean().default(false),
	idempotencyKey: z.string().min(8).max(128),
});

export type ObjectAlterRequest = z.infer<typeof objectAlterRequestSchema>;

export const objectAlterResultSchema = z.object({
	/** Exactly what would run, or did. Rendered for approval verbatim. */
	statements: z.array(z.string()),
	/** 0 for a dry run. */
	applied: z.number().int(),
});

export type ObjectAlterResult = z.infer<typeof objectAlterResultSchema>;

/**
 * `dropColumn` is the destructive one and is gated like the danger zone:
 * a typed confirmation of the object name. Everything else is either
 * additive or reversible.
 */
export function isDestructiveChange(change: ColumnChange): boolean {
	return change.type === "drop" || change.type === "setType";
}
