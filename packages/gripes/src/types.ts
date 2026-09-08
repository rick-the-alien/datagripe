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
	| "access"
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

/**
 * One object's resolved access, for the `grant.*` rules
 * (docs/spec/access-report.md "Findings, not opinions in the margin").
 *
 * Everything here is already *effective* — `has_*_privilege` resolved
 * PUBLIC, inheritance and superuser, and `blocked` records that the role
 * cannot enter the schema. A rule must never re-derive reachability from
 * an ACL, because that is the mistake the whole report exists to fix.
 */
export interface AccessInput {
	connectionId: string;
	schema: string;
	name: string;
	kind: "table" | "view" | "function" | "procedure" | "sequence";
	owner: string;
	rls: "none" | "off" | "on" | "forced";
	policyCount: number;
	/** Views: false when the view reads base relations as its owner. */
	securityInvoker: boolean | null;
	securityDefiner: boolean | null;
	searchPathPinned: boolean | null;
	/** Per-role effective reach, untrusted marks already applied. */
	reach: Array<{
		role: string;
		untrusted: boolean;
		privileges: string[];
		/** True when the role has no USAGE on the schema, so the privileges
		 * above are inert. */
		blocked: boolean;
	}>;
	/**
	 * Base relations this view exposes that an untrusted role cannot read
	 * directly. Null when the question was not asked (not a view, or the
	 * dependency read was unavailable) — and a rule that gets null stays
	 * silent rather than guessing.
	 */
	viewBypass: Array<{ role: string; relation: string }> | null;
	/** `ALTER DEFAULT PRIVILEGES` entries granting to an untrusted role. */
	defaultAclUntrusted: Array<{ grantee: string; objectType: string }>;
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
	access?: AccessInput;
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

/**
 * Convenience for a rule building an object-scoped finding.
 *
 * `tab` is the object-view tab the finding's subject lives in, so an
 * index complaint stays on `indexes` rather than following the reader to
 * `grants`. Omit it for something that belongs to the object as a whole.
 */
export function objectLocation(
	object: ObjectInput,
	tab?: string,
): GripeLocation {
	return {
		kind: "object",
		connectionId: object.connectionId,
		schema: object.schema,
		name: object.name,
		objectKind: object.kind,
		...(tab === undefined ? {} : { tab }),
	};
}

/** Convenience for a rule building an access-scoped finding. */
export function accessLocation(access: AccessInput): GripeLocation {
	return {
		kind: "object",
		connectionId: access.connectionId,
		schema: access.schema,
		name: access.name,
		objectKind: access.kind,
		tab: "grants",
	};
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
