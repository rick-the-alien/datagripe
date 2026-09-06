import type {
	ObjectColumn,
	ObjectConstraint,
	ObjectDependent,
	ObjectDescribeResult,
	ObjectGrant,
	ObjectIndex,
	ObjectTrigger,
} from "@datagripe/contracts";
import type { SQL } from "bun";
import {
	formatAgo,
	formatBytes,
	formatCount,
	statTiles,
} from "../object/format";
import { TableRequestError } from "../table/builder";
import type { ObjectRequest, TableLimits } from "../types";

/**
 * MySQL object view (docs/spec/object-view.md). Every projection is
 * aliased because MySQL returns information_schema column names
 * upper-cased, so an unaliased field arrives as IS_NULLABLE.
 *
 * MySQL has no per-index size in information_schema without InnoDB
 * internals, so index sizes are reported as unknown rather than guessed.
 */

const COLUMNS_SQL = `
	SELECT column_name AS name,
		column_type AS data_type,
		is_nullable AS is_nullable,
		column_default AS column_default,
		column_key AS column_key,
		column_comment AS column_comment
	FROM information_schema.columns
	WHERE table_schema = ? AND table_name = ?
	ORDER BY ordinal_position`;

const INDEXES_SQL = `
	SELECT index_name AS name,
		MIN(index_type) AS method,
		GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', ') AS columns,
		MIN(non_unique) AS non_unique
	FROM information_schema.statistics
	WHERE table_schema = ? AND table_name = ?
	GROUP BY index_name
	ORDER BY (index_name = 'PRIMARY') DESC, index_name`;

const CONSTRAINTS_SQL = `
	SELECT tc.constraint_name AS name,
		LOWER(tc.constraint_type) AS type,
		GROUP_CONCAT(kcu.column_name ORDER BY kcu.ordinal_position SEPARATOR ', ') AS columns,
		MIN(kcu.referenced_table_name) AS referenced_table,
		GROUP_CONCAT(kcu.referenced_column_name ORDER BY kcu.ordinal_position SEPARATOR ', ') AS referenced_columns
	FROM information_schema.table_constraints tc
	LEFT JOIN information_schema.key_column_usage kcu
		ON kcu.constraint_schema = tc.constraint_schema
		AND kcu.constraint_name = tc.constraint_name
		AND kcu.table_name = tc.table_name
	WHERE tc.table_schema = ? AND tc.table_name = ?
	GROUP BY tc.constraint_name, tc.constraint_type
	ORDER BY tc.constraint_type, tc.constraint_name`;

const CHECKS_SQL = `
	SELECT cc.constraint_name AS name, cc.check_clause AS check_clause
	FROM information_schema.check_constraints cc
	JOIN information_schema.table_constraints tc
		ON tc.constraint_schema = cc.constraint_schema
		AND tc.constraint_name = cc.constraint_name
	WHERE tc.table_schema = ? AND tc.table_name = ?`;

const TRIGGERS_SQL = `
	SELECT trigger_name AS name,
		LOWER(action_timing) AS timing,
		LOWER(event_manipulation) AS events,
		action_statement AS action
	FROM information_schema.triggers
	WHERE event_object_schema = ? AND event_object_table = ?
	ORDER BY trigger_name`;

const GRANTS_SQL = `
	SELECT grantee AS grantee,
		GROUP_CONCAT(LOWER(privilege_type) ORDER BY privilege_type SEPARATOR ', ') AS privileges
	FROM information_schema.table_privileges
	WHERE table_schema = ? AND table_name = ?
	GROUP BY grantee
	ORDER BY grantee`;

const STATISTICS_SQL = `
	SELECT table_rows AS table_rows,
		data_length AS data_length,
		index_length AS index_length,
		data_free AS data_free,
		engine AS engine,
		table_collation AS table_collation,
		create_time AS create_time,
		update_time AS update_time
	FROM information_schema.tables
	WHERE table_schema = ? AND table_name = ?`;

const DEPENDENT_KEYS_SQL = `
	SELECT 'foreign key' AS kind,
		CONCAT(table_schema, '.', table_name, ' (', constraint_name, ')') AS name
	FROM information_schema.key_column_usage
	WHERE referenced_table_schema = ? AND referenced_table_name = ?
	GROUP BY table_schema, table_name, constraint_name
	ORDER BY name`;

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

function nullableNumber(value: unknown): number | null {
	const parsed = Number(value);
	return value === null || value === undefined || !Number.isFinite(parsed)
		? null
		: parsed;
}

export async function describeMysqlObject(
	client: SQL,
	request: ObjectRequest,
	limits: TableLimits,
): Promise<ObjectDescribeResult> {
	const reserved = await client.reserve();
	try {
		await reserved.unsafe(
			`SET SESSION max_execution_time = ${Math.max(
				1,
				Math.floor(limits.timeoutMs),
			)}`,
		);
		const query = async (sql: string): Promise<Row[]> =>
			(await reserved.unsafe(sql, [request.schema, request.name])) as Row[];

		const columnRows = await query(COLUMNS_SQL);
		if (columnRows.length === 0) {
			throw new TableRequestError(
				`'${request.schema}.${request.name}' was not found`,
			);
		}
		const indexRows = await query(INDEXES_SQL);
		const constraintRows = await query(CONSTRAINTS_SQL);
		// CHECK constraints only exist from MySQL 8.0.16 / MariaDB 10.2; an
		// older server has no such view and the tab is still correct without
		// them.
		const checkRows = await query(CHECKS_SQL).catch(() => [] as Row[]);
		const triggerRows = await query(TRIGGERS_SQL);
		const grantRows = await query(GRANTS_SQL);
		const statRows = await query(STATISTICS_SQL);
		const dependentKeyRows =
			request.kind === "table" ? await query(DEPENDENT_KEYS_SQL) : [];

		const columns: ObjectColumn[] = columnRows.map((row) => ({
			name: text(row.name),
			dataType: text(row.data_type),
			nullable: text(row.is_nullable).toUpperCase() === "YES",
			defaultExpr: nullableText(row.column_default),
			primaryKey: text(row.column_key).toUpperCase() === "PRI",
			comment: nullableText(row.column_comment),
		}));

		const indexes: ObjectIndex[] = indexRows.map((row) => ({
			name: text(row.name),
			method: text(row.method).toLowerCase(),
			columns: text(row.columns),
			unique: Number(row.non_unique) === 0,
			primary: text(row.name) === "PRIMARY",
			sizeBytes: null,
		}));

		const checkByName = new Map(
			checkRows.map((row) => [text(row.name), text(row.check_clause)]),
		);
		const constraints: ObjectConstraint[] = constraintRows.map((row) => {
			const name = text(row.name);
			const type = text(row.type);
			const check = checkByName.get(name);
			if (check !== undefined) {
				return { name, type: "check", definition: `check (${check})` };
			}
			const referenced = nullableText(row.referenced_table);
			const definition =
				referenced === null
					? `${type} (${text(row.columns)})`
					: `foreign key (${text(row.columns)}) references ${referenced} (${text(
							row.referenced_columns,
						)})`;
			return { name, type, definition };
		});

		const triggers: ObjectTrigger[] = triggerRows.map((row) => ({
			name: text(row.name),
			timing: text(row.timing),
			events: text(row.events),
			action: text(row.action),
			// MySQL has no way to disable a trigger; one that exists runs.
			enabled: true,
		}));

		const grants: ObjectGrant[] = grantRows.map((row) => ({
			grantee: text(row.grantee),
			privileges: text(row.privileges),
			grantor: null,
		}));

		const stat = statRows[0] ?? {};
		const rowEstimate = nullableNumber(stat.table_rows);
		const statistics = statTiles([
			["rows (estimated)", formatCount(rowEstimate)],
			["data", formatBytes(nullableNumber(stat.data_length))],
			["indexes", formatBytes(nullableNumber(stat.index_length))],
			["free", formatBytes(nullableNumber(stat.data_free))],
			["engine", nullableText(stat.engine)],
			["collation", nullableText(stat.table_collation)],
			["updated", formatAgo(nullableText(stat.update_time))],
		]);

		// SHOW CREATE is verbatim DDL, which is the whole point of the tab.
		const showRows = (await reserved.unsafe(
			`SHOW CREATE ${request.kind === "view" ? "VIEW" : "TABLE"} \`${request.schema.replaceAll(
				"`",
				"``",
			)}\`.\`${request.name.replaceAll("`", "``")}\``,
		)) as Row[];
		const showRow = showRows[0] ?? {};
		const ddl =
			nullableText(showRow["Create Table"]) ??
			nullableText(showRow["Create View"]);

		const dependents: ObjectDependent[] = dependentKeyRows.map((row) => ({
			kind: text(row.kind),
			name: text(row.name),
		}));

		return {
			schema: request.schema,
			name: request.name,
			kind: request.kind,
			rowEstimate,
			// information_schema.table_rows is an InnoDB estimate, always.
			estimated: rowEstimate !== null,
			columns,
			indexes,
			constraints,
			triggers,
			grants,
			statistics,
			ddl,
			unsupported: [],
			ddlReconstructed: false,
			dependents,
		};
	} finally {
		reserved.release();
	}
}
