import type {
	ObjectArgument,
	ObjectDescribeResult,
	ObjectGrant,
} from "@datagripe/contracts";
import { tabsForKind } from "@datagripe/contracts";
import { formatCount, statTiles } from "../object/format";
import { TableRequestError } from "../table/builder";
import type { ObjectRequest } from "../types";

/**
 * MySQL routines for the object view (docs/spec/object-view.md).
 * `SHOW CREATE FUNCTION` / `PROCEDURE` returns the definition verbatim,
 * which is the point of double-clicking one. MySQL has no sequences.
 *
 * Every projection is aliased: MySQL returns information_schema column
 * names upper-cased.
 */

type Row = Record<string, unknown>;

function text(value: unknown): string {
	return value === null || value === undefined ? "" : String(value);
}

function nullableText(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	const asText = String(value);
	return asText === "" ? null : asText;
}

const ROUTINE_SQL = `
	SELECT routine_name AS name,
		LOWER(routine_type) AS routine_type,
		dtd_identifier AS returns,
		LOWER(external_language) AS language,
		is_deterministic AS is_deterministic,
		LOWER(sql_data_access) AS sql_data_access,
		LOWER(security_type) AS security_type,
		definer AS definer,
		routine_comment AS routine_comment
	FROM information_schema.routines
	WHERE routine_schema = ? AND routine_name = ?`;

const PARAMETERS_SQL = `
	SELECT parameter_name AS name,
		dtd_identifier AS data_type,
		LOWER(COALESCE(parameter_mode, 'in')) AS mode
	FROM information_schema.parameters
	WHERE specific_schema = ? AND specific_name = ?
		AND parameter_name IS NOT NULL
	ORDER BY ordinal_position`;

const ROUTINE_GRANTS_SQL = `
	SELECT grantee AS grantee,
		GROUP_CONCAT(LOWER(privilege_type) ORDER BY privilege_type SEPARATOR ', ') AS privileges
	FROM information_schema.schema_privileges
	WHERE table_schema = ?
	GROUP BY grantee
	ORDER BY grantee`;

export async function describeMysqlRoutine(
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

	const parameterRows = await query(PARAMETERS_SQL, [
		request.schema,
		request.name,
	]);
	const args: ObjectArgument[] = parameterRows.map((row) => ({
		name: text(row.name),
		dataType: text(row.data_type),
		mode: text(row.mode),
	}));

	// MySQL grants routines at the schema level in information_schema, so
	// this is the schema's grantees rather than the routine's own — close
	// enough to be useful, and the tab header says schema.
	const grantRows = await query(ROUTINE_GRANTS_SQL, [request.schema]).catch(
		() => [] as Row[],
	);
	const grants: ObjectGrant[] = grantRows.map((row) => ({
		grantee: text(row.grantee),
		privileges: text(row.privileges),
		grantor: null,
	}));

	const statistics = statTiles([
		["language", nullableText(routine.language) ?? "sql"],
		["returns", nullableText(routine.returns)],
		["kind", nullableText(routine.routine_type)],
		["arguments", formatCount(args.length)],
		[
			"deterministic",
			text(routine.is_deterministic).toUpperCase() === "YES" ? "yes" : "no",
		],
		["data access", nullableText(routine.sql_data_access)],
		["security", nullableText(routine.security_type)],
		["definer", nullableText(routine.definer)],
		["comment", nullableText(routine.routine_comment)],
	]);

	const keyword = request.kind === "procedure" ? "PROCEDURE" : "FUNCTION";
	const showRows = await query(
		`SHOW CREATE ${keyword} \`${request.schema.replaceAll(
			"`",
			"``",
		)}\`.\`${request.name.replaceAll("`", "``")}\``,
		[],
	);
	const showRow = showRows[0] ?? {};
	const ddl =
		nullableText(
			showRow[`Create ${keyword === "PROCEDURE" ? "Procedure" : "Function"}`],
		) ??
		nullableText(showRow["Create Procedure"]) ??
		nullableText(showRow["Create Function"]);

	return {
		schema: request.schema,
		name: request.name,
		kind: request.kind,
		tabs: tabsForKind(request.kind),
		rowEstimate: null,
		estimated: false,
		columns: [],
		arguments: args,
		indexes: [],
		constraints: [],
		triggers: [],
		grants,
		statistics,
		ddl,
		unsupported: [],
		ddlReconstructed: false,
		dependents: [],
	};
}
