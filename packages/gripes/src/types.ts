import type {
	Finding,
	GripeLocation,
	GripeSeverity,
} from "@datagripe/contracts";
import type { SqlDialect, SqlToken } from "@datagripe/sql-tools";

/**
 * The rule shape (docs/spec/gripes.md "The shape of a rule").
 *
 * A rule is a pure function that declares what it needs. The runner
 * gives it exactly that and nothing else, which is what lets the same
 * catalogue run in the client for the inputs already in memory and in
 * the server for the inputs that need a connection.
 */

/** What a rule needs to decide. */
export type RuleInput =
	| "statement"
	| "schema"
	| "object"
	| "execution"
	| "plan";

/** One statement, tokenized, with its position in the document. */
export interface StatementInput {
	documentId: string;
	dialect: SqlDialect;
	/** The statement text. */
	text: string;
	/** Offset of `text` within the document. */
	offset: number;
	/** Tokens, already scanned — every statement rule wants them. */
	tokens: SqlToken[];
}

/**
 * What a rule may ask about the schema. Every method may answer `null`
 * for "not known", and a rule that gets `null` must stay silent rather
 * than guess (docs/spec/gripes.md).
 */
export interface SchemaInput {
	/** Row estimate for a relation, or null when unknown. */
	rowsFor: (schema: string | null, table: string) => number | null;
	/** Whether an index leads with this column, or null when unknown. */
	indexLeadsWith: (
		schema: string | null,
		table: string,
		column: string,
	) => boolean | null;
	/** Whether a column is nullable, or null when unknown. */
	isNullable: (
		schema: string | null,
		table: string,
		column: string,
	) => boolean | null;
}

/** A described object, for structural rules. */
export interface ObjectInput {
	connectionId: string;
	schema: string;
	name: string;
	kind: "table" | "view" | "function" | "procedure" | "sequence";
	/** The `object.describe` result, structurally. */
	columns: Array<{ name: string; primaryKey: boolean; nullable: boolean }>;
	indexes: Array<{ name: string; columns: string; unique: boolean }>;
	rowEstimate: number | null;
	ddl: string | null;
}

/** How an execution turned out, for runtime rules. */
export interface ExecutionInput {
	executionId: string;
	rowCount: number | null;
	elapsedMs: number | null;
	truncated: boolean;
}

/**
 * Everything available this time round. A rule only ever reads the
 * fields matching its declared inputs; the runner enforces that by not
 * calling rules whose inputs are absent.
 */
export interface GripeContext {
	statement?: StatementInput;
	schema?: SchemaInput;
	object?: ObjectInput;
	execution?: ExecutionInput;
}

export interface Rule {
	/** `<subject>.<problem>` — stable, and a public contract. */
	id: string;
	severity: GripeSeverity;
	inputs: RuleInput[];
	/**
	 * Returns nothing when it cannot tell. Never a hedge: "if the tool is
	 * not sure, it says nothing".
	 */
	evaluate: (context: GripeContext) => Finding[];
}

/** Convenience for a rule building a document-ranged finding. */
export function documentLocation(
	statement: StatementInput,
	start: number,
	end: number,
): GripeLocation {
	return {
		kind: "document",
		documentId: statement.documentId,
		start: statement.offset + start,
		end: statement.offset + end,
	};
}
