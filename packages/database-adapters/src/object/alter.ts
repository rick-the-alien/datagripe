import type {
	ColumnChange,
	ColumnChangeKind,
	ObjectColumn,
} from "@datagripe/contracts";
import {
	assertSingleExpression,
	qualify,
	type TableDialect,
	TableRequestError,
} from "../table/builder";

/**
 * Column DDL per dialect (docs/spec/object-view.md "Editing columns").
 *
 * These builders produce text only — nothing here executes. The object
 * view shows the result for approval first, which is the gating for
 * structural change: a typed confirmation on every field edit would be
 * noise, but reading the statement you are about to run is not.
 *
 * Identifiers are quoted. Types are validated to a type-shaped pattern
 * by the contract, because no engine accepts a bind parameter where a
 * type goes. Default expressions are checked for statement stacking the
 * same way the table view's `where …` box is.
 */

export interface AlterDialect extends TableDialect {
	/** How this engine spells a column's nullability change. */
	columnStyle: "postgres" | "mysql" | "sqlite";
	/** Column changes this engine can express at all. */
	supports: ColumnChangeKind[];
	/** True when a column comment is its own statement rather than part
	 * of the column definition. */
	standaloneComments: boolean;
}

export const POSTGRES_ALTER: Pick<
	AlterDialect,
	"columnStyle" | "supports" | "standaloneComments"
> = {
	columnStyle: "postgres",
	supports: [
		"add",
		"rename",
		"setType",
		"setNullable",
		"setDefault",
		"setComment",
		"drop",
	],
	standaloneComments: true,
};

export const MYSQL_ALTER: Pick<
	AlterDialect,
	"columnStyle" | "supports" | "standaloneComments"
> = {
	columnStyle: "mysql",
	supports: [
		"add",
		"rename",
		"setType",
		"setNullable",
		"setDefault",
		"setComment",
		"drop",
	],
	standaloneComments: false,
};

export const SQLITE_ALTER: Pick<
	AlterDialect,
	"columnStyle" | "supports" | "standaloneComments"
> = {
	columnStyle: "sqlite",
	supports: ["add", "rename", "drop"],
	standaloneComments: false,
};

/** Human-readable reason a change cannot be expressed on this engine. */
const UNSUPPORTED_REASON: Record<string, string> = {
	sqlite:
		"SQLite's ALTER TABLE cannot do this — it needs the table rebuilt, which this view does not do",
};

function assertSupported(dialect: AlterDialect, change: ColumnChange): void {
	if (!dialect.supports.includes(change.type)) {
		const reason =
			UNSUPPORTED_REASON[dialect.columnStyle] ??
			"This engine cannot express that change";
		throw new TableRequestError(`'${change.type}' is not available: ${reason}`);
	}
}

function assertKnownColumn(
	columns: ObjectColumn[],
	name: string,
): ObjectColumn {
	const column = columns.find((entry) => entry.name === name);
	if (column === undefined) {
		throw new TableRequestError(`Unknown column '${name}'`);
	}
	return column;
}

function checkedDefault(
	dialect: AlterDialect,
	expression: string | null,
): string | null {
	if (expression === null) {
		return null;
	}
	const trimmed = expression.trim();
	if (trimmed === "") {
		return null;
	}
	assertSingleExpression(trimmed, dialect);
	return trimmed;
}

/** A literal for a comment, quoted for the engine's string syntax. */
function commentLiteral(dialect: AlterDialect, comment: string): string {
	const escaped = comment.replaceAll("'", "''");
	// MySQL also honours backslash escapes inside strings, so a trailing
	// backslash would swallow the closing quote.
	return dialect.columnStyle === "mysql"
		? `'${escaped.replaceAll("\\", "\\\\")}'`
		: `'${escaped}'`;
}

/**
 * MySQL has no per-attribute column ALTER: `MODIFY COLUMN` restates the
 * whole definition, so anything not being changed has to be carried over
 * from the column as it currently is.
 */
function mysqlColumnDefinition(
	dialect: AlterDialect,
	column: ObjectColumn,
	overrides: Partial<{
		dataType: string;
		nullable: boolean;
		defaultExpr: string | null;
		comment: string | null;
	}>,
): string {
	const dataType = overrides.dataType ?? column.dataType;
	const nullable = overrides.nullable ?? column.nullable;
	const defaultExpr =
		"defaultExpr" in overrides ? overrides.defaultExpr : column.defaultExpr;
	const comment = "comment" in overrides ? overrides.comment : column.comment;
	const parts = [dataType, nullable ? "NULL" : "NOT NULL"];
	if (defaultExpr !== null && defaultExpr !== undefined) {
		parts.push(`DEFAULT ${defaultExpr}`);
	}
	if (comment !== null && comment !== undefined && comment !== "") {
		parts.push(`COMMENT ${commentLiteral(dialect, comment)}`);
	}
	return parts.join(" ");
}

export interface AlterTarget {
	schema: string;
	name: string;
	/** The columns as they are now, for engines that restate definitions. */
	columns: ObjectColumn[];
}

/**
 * One change becomes one or more statements. Returned as text so the
 * caller can show them before deciding to run them.
 */
export function columnChangeStatements(
	dialect: AlterDialect,
	target: AlterTarget,
	change: ColumnChange,
): string[] {
	assertSupported(dialect, change);
	const { quote } = dialect;
	const table = qualify(dialect, target.schema, target.name);

	switch (change.type) {
		case "add": {
			const defaultExpr = checkedDefault(dialect, change.defaultExpr);
			const parts = [
				`ALTER TABLE ${table} ADD COLUMN ${quote(change.name)} ${change.dataType}`,
			];
			if (!change.nullable) {
				parts.push("NOT NULL");
			}
			if (defaultExpr !== null) {
				parts.push(`DEFAULT ${defaultExpr}`);
			}
			if (
				!dialect.standaloneComments &&
				change.comment !== null &&
				change.comment !== ""
			) {
				parts.push(`COMMENT ${commentLiteral(dialect, change.comment)}`);
			}
			const statements = [`${parts.join(" ")};`];
			if (
				dialect.standaloneComments &&
				change.comment !== null &&
				change.comment !== ""
			) {
				statements.push(
					`COMMENT ON COLUMN ${table}.${quote(change.name)} IS ${commentLiteral(
						dialect,
						change.comment,
					)};`,
				);
			}
			return statements;
		}

		case "rename": {
			assertKnownColumn(target.columns, change.name);
			return [
				`ALTER TABLE ${table} RENAME COLUMN ${quote(change.name)} TO ${quote(
					change.newName,
				)};`,
			];
		}

		case "setType": {
			const column = assertKnownColumn(target.columns, change.name);
			if (dialect.columnStyle === "mysql") {
				return [
					`ALTER TABLE ${table} MODIFY COLUMN ${quote(
						change.name,
					)} ${mysqlColumnDefinition(dialect, column, {
						dataType: change.dataType,
					})};`,
				];
			}
			// USING makes the cast explicit, which is the difference between
			// "postgres refuses this" and "postgres does what you meant".
			return [
				`ALTER TABLE ${table} ALTER COLUMN ${quote(change.name)} TYPE ${
					change.dataType
				} USING ${quote(change.name)}::${change.dataType};`,
			];
		}

		case "setNullable": {
			const column = assertKnownColumn(target.columns, change.name);
			if (dialect.columnStyle === "mysql") {
				return [
					`ALTER TABLE ${table} MODIFY COLUMN ${quote(
						change.name,
					)} ${mysqlColumnDefinition(dialect, column, {
						nullable: change.nullable,
					})};`,
				];
			}
			return [
				`ALTER TABLE ${table} ALTER COLUMN ${quote(change.name)} ${
					change.nullable ? "DROP NOT NULL" : "SET NOT NULL"
				};`,
			];
		}

		case "setDefault": {
			const column = assertKnownColumn(target.columns, change.name);
			const defaultExpr = checkedDefault(dialect, change.defaultExpr);
			if (dialect.columnStyle === "mysql") {
				return [
					`ALTER TABLE ${table} MODIFY COLUMN ${quote(
						change.name,
					)} ${mysqlColumnDefinition(dialect, column, { defaultExpr })};`,
				];
			}
			return [
				`ALTER TABLE ${table} ALTER COLUMN ${quote(change.name)} ${
					defaultExpr === null ? "DROP DEFAULT" : `SET DEFAULT ${defaultExpr}`
				};`,
			];
		}

		case "setComment": {
			const column = assertKnownColumn(target.columns, change.name);
			if (dialect.standaloneComments) {
				return [
					`COMMENT ON COLUMN ${table}.${quote(change.name)} IS ${
						change.comment === null || change.comment === ""
							? "NULL"
							: commentLiteral(dialect, change.comment)
					};`,
				];
			}
			return [
				`ALTER TABLE ${table} MODIFY COLUMN ${quote(
					change.name,
				)} ${mysqlColumnDefinition(dialect, column, {
					comment: change.comment,
				})};`,
			];
		}

		default: {
			assertKnownColumn(target.columns, change.name);
			return [`ALTER TABLE ${table} DROP COLUMN ${quote(change.name)};`];
		}
	}
}

/**
 * Every statement for a batch, in the order given. Renames go last
 * within the batch the client sends, because a rename invalidates the
 * name every other change refers to — the client orders them; this
 * asserts it rather than silently reordering.
 */
export function alterStatements(
	dialect: AlterDialect,
	target: AlterTarget,
	changes: ColumnChange[],
): string[] {
	const renamed = new Set<string>();
	const statements: string[] = [];
	for (const change of changes) {
		if (renamed.has(change.name)) {
			throw new TableRequestError(
				`Column '${change.name}' was renamed earlier in this batch; apply the rename on its own`,
			);
		}
		statements.push(...columnChangeStatements(dialect, target, change));
		if (change.type === "rename") {
			renamed.add(change.name);
		}
	}
	return statements;
}
