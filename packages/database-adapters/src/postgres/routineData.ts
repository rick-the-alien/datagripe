import type {
	ObjectArgument,
	ObjectDescribeResult,
	ObjectGrant,
} from "@datagripe/contracts";
import { tabsForKind } from "@datagripe/contracts";
import { formatCount, statTiles } from "../object/format";
import { POSTGRES_TABLE_DIALECT, TableRequestError } from "../table/builder";
import type { ObjectRequest } from "../types";

/**
 * PostgreSQL routines and sequences for the object view
 * (docs/spec/object-view.md).
 *
 * A routine's DDL is the one place PostgreSQL does export it verbatim:
 * `pg_get_functiondef` returns the exact `CREATE OR REPLACE FUNCTION`,
 * body and all. That is why double-clicking a function lands on the ddl
 * tab — it is the whole object, not a summary of it.
 */

type Row = Record<string, unknown>;

function text(value: unknown): string {
	return value === null || value === undefined ? "" : String(value);
}

function nullableText(value: unknown): string | null {
	return value === null || value === undefined ? null : String(value);
}

/**
 * The tree names a routine `proname(identity args)` so overloads stay
 * distinct, and that is exactly the string that comes back here — so it
 * is also what identifies the row.
 */
const ROUTINE_SQL = `
	SELECT p.oid AS oid,
		p.proname AS name,
		pg_get_functiondef(p.oid) AS definition,
		pg_get_function_result(p.oid) AS returns,
		l.lanname AS language,
		CASE p.provolatile
			WHEN 'i' THEN 'immutable'
			WHEN 's' THEN 'stable'
			ELSE 'volatile'
		END AS volatility,
		CASE p.prokind
			WHEN 'p' THEN 'procedure'
			WHEN 'a' THEN 'aggregate'
			WHEN 'w' THEN 'window'
			ELSE 'function'
		END AS routine_kind,
		p.proisstrict AS strict,
		p.prosecdef AS security_definer,
		pg_get_userbyid(p.proowner) AS owner,
		obj_description(p.oid, 'pg_proc') AS comment,
		p.pronargs AS arg_count
	FROM pg_proc p
	JOIN pg_namespace n ON n.oid = p.pronamespace
	JOIN pg_language l ON l.oid = p.prolang
	WHERE n.nspname = $1
		AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = $2`;

/**
 * Argument rows. The three parallel arrays in pg_proc are unnested
 * together rather than parsed out of `pg_get_function_arguments`: a
 * default value can contain a comma, so splitting that string is wrong
 * for exactly the functions people care about.
 */
const ARGUMENTS_SQL = `
	SELECT a.ordinality AS position,
		a.argname AS name,
		format_type(a.argtype, NULL) AS data_type,
		CASE a.argmode
			WHEN 'o' THEN 'out'
			WHEN 'b' THEN 'inout'
			WHEN 'v' THEN 'variadic'
			WHEN 't' THEN 'table'
			ELSE 'in'
		END AS mode
	FROM pg_proc p
	CROSS JOIN LATERAL unnest(
		COALESCE(p.proallargtypes, p.proargtypes::oid[]),
		COALESCE(
			p.proargmodes,
			array_fill('i'::"char", ARRAY[
				COALESCE(array_length(COALESCE(p.proallargtypes, p.proargtypes::oid[]), 1), 0)
			])
		),
		COALESCE(
			p.proargnames,
			array_fill(NULL::text, ARRAY[
				COALESCE(array_length(COALESCE(p.proallargtypes, p.proargtypes::oid[]), 1), 0)
			])
		)
	) WITH ORDINALITY AS a(argtype, argmode, argname, ordinality)
	WHERE p.oid = $1
	ORDER BY a.ordinality`;

const ROUTINE_GRANTS_SQL = `
	SELECT grantee,
		string_agg(lower(privilege_type), ', ' ORDER BY privilege_type) AS privileges,
		min(grantor) AS grantor
	FROM information_schema.role_routine_grants
	WHERE specific_schema = $1 AND specific_name = $2 || '_' || $3::text
	GROUP BY grantee
	ORDER BY grantee`;

const SEQUENCE_SQL = `
	SELECT s.start_value,
		s.min_value,
		s.max_value,
		s.increment_by,
		s.cycle,
		s.cache_size,
		s.last_value,
		s.data_type::text AS data_type,
		pg_get_userbyid(c.relowner) AS owner,
		(
			SELECT dn.nspname || '.' || dc.relname || '.' || da.attname
			FROM pg_depend d
			JOIN pg_class dc ON dc.oid = d.refobjid
			JOIN pg_namespace dn ON dn.oid = dc.relnamespace
			JOIN pg_attribute da
				ON da.attrelid = d.refobjid AND da.attnum = d.refobjsubid
			WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')
			LIMIT 1
		) AS owned_by
	FROM pg_sequences s
	JOIN pg_class c ON c.relname = s.sequencename
	JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname
	WHERE s.schemaname = $1 AND s.sequencename = $2`;

/** Nothing in a routine or sequence fills these. */
function emptyRelationParts() {
	return {
		columns: [],
		indexes: [],
		constraints: [],
		triggers: [],
		dependents: [],
		rowEstimate: null,
		estimated: false,
	};
}

export async function describePostgresRoutine(
	query: (sql: string, params: unknown[]) => Promise<Row[]>,
	request: ObjectRequest,
): Promise<ObjectDescribeResult> {
	const rows = await query(ROUTINE_SQL, [request.schema, request.name]);
	const routine = rows[0];
	if (routine === undefined) {
		throw new TableRequestError(
			`'${request.schema}.${request.name}' was not found`,
		);
	}
	const oid = routine.oid;

	const argumentRows = await query(ARGUMENTS_SQL, [oid]);
	const args: ObjectArgument[] = argumentRows.map((row, index) => ({
		// An unnamed positional argument is `$1` in the body, so that is
		// what it is called here too.
		name: nullableText(row.name) ?? `$${index + 1}`,
		dataType: text(row.data_type),
		mode: text(row.mode),
	}));

	const grantRows = await query(ROUTINE_GRANTS_SQL, [
		request.schema,
		text(routine.name),
		oid,
	]).catch(() => [] as Row[]);
	const grants: ObjectGrant[] = grantRows.map((row) => ({
		grantee: text(row.grantee),
		privileges: text(row.privileges),
		grantor: nullableText(row.grantor),
	}));

	const statistics = statTiles([
		["language", nullableText(routine.language)],
		["returns", nullableText(routine.returns)],
		["volatility", nullableText(routine.volatility)],
		["arguments", formatCount(args.length)],
		["strict", routine.strict === true ? "yes" : "no"],
		["security", routine.security_definer === true ? "definer" : "invoker"],
		["owner", nullableText(routine.owner)],
		["comment", nullableText(routine.comment)],
	]);

	return {
		schema: request.schema,
		name: request.name,
		kind: request.kind,
		tabs: tabsForKind(request.kind),
		...emptyRelationParts(),
		arguments: args,
		grants,
		statistics,
		// pg_get_functiondef is the real thing, body included.
		ddl: nullableText(routine.definition),
		unsupported: [],
		ddlReconstructed: false,
	};
}

export async function describePostgresSequence(
	query: (sql: string, params: unknown[]) => Promise<Row[]>,
	request: ObjectRequest,
): Promise<ObjectDescribeResult> {
	const rows = await query(SEQUENCE_SQL, [request.schema, request.name]);
	const sequence = rows[0];
	if (sequence === undefined) {
		throw new TableRequestError(
			`'${request.schema}.${request.name}' was not found`,
		);
	}

	const quote = POSTGRES_TABLE_DIALECT.quote;
	const dataType = text(sequence.data_type) || "bigint";
	const ddl = [
		`create sequence ${quote(request.schema)}.${quote(request.name)}`,
		`  as ${dataType}`,
		`  increment by ${text(sequence.increment_by)}`,
		`  minvalue ${text(sequence.min_value)}`,
		`  maxvalue ${text(sequence.max_value)}`,
		`  start with ${text(sequence.start_value)}`,
		`  cache ${text(sequence.cache_size)}`,
		sequence.cycle === true ? "  cycle;" : "  no cycle;",
	].join("\n");

	const statistics = statTiles([
		["last value", formatCount(Number(sequence.last_value))],
		["increment", nullableText(sequence.increment_by)],
		["start", nullableText(sequence.start_value)],
		["minimum", nullableText(sequence.min_value)],
		["maximum", nullableText(sequence.max_value)],
		["cache", nullableText(sequence.cache_size)],
		["cycles", sequence.cycle === true ? "yes" : "no"],
		["type", dataType],
		["owned by", nullableText(sequence.owned_by)],
		["owner", nullableText(sequence.owner)],
	]);

	return {
		schema: request.schema,
		name: request.name,
		kind: request.kind,
		tabs: tabsForKind(request.kind),
		...emptyRelationParts(),
		arguments: [],
		grants: [],
		statistics,
		ddl,
		unsupported: [],
		// PostgreSQL has no pg_get_sequencedef; this is rebuilt from
		// pg_sequences.
		ddlReconstructed: true,
	};
}
