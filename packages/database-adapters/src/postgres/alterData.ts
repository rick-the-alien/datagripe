import type { ObjectAlterResult } from "@datagripe/contracts";
import type { SQL } from "bun";
import { POSTGRES_ALTER } from "../object/alter";
import { applyColumnChanges } from "../object/applyAlter";
import { POSTGRES_TABLE_DIALECT } from "../table/builder";
import type {
	ObjectAlterExecution,
	ResolvedConnection,
	TableLimits,
} from "../types";
import { describePostgresObject } from "./objectData";

/**
 * PostgreSQL column changes (docs/spec/object-view.md). PostgreSQL is
 * the one engine here with transactional DDL, so a failed batch leaves
 * the table exactly as it was.
 */

const DIALECT = { ...POSTGRES_TABLE_DIALECT, ...POSTGRES_ALTER };

export async function alterPostgresColumns(
	client: SQL,
	connection: ResolvedConnection,
	request: ObjectAlterExecution,
	limits: TableLimits,
): Promise<ObjectAlterResult> {
	// The current shape is read first: a rename has to name a column that
	// exists, and MySQL-style restatement needs the existing definition.
	const current = await describePostgresObject(
		client,
		{ schema: request.schema, name: request.name, kind: "table" },
		limits,
	);

	const reserved = await client.reserve();
	try {
		await reserved.unsafe(
			`SET statement_timeout = ${Math.max(1, Math.floor(limits.timeoutMs))}`,
		);
		return await applyColumnChanges({
			session: {
				transactional: true,
				execute: async (sql) => {
					await reserved.unsafe(sql);
				},
				begin: async () => {
					await reserved.unsafe("BEGIN");
				},
				commit: async () => {
					await reserved.unsafe("COMMIT");
				},
				rollback: async () => {
					await reserved.unsafe("ROLLBACK");
				},
			},
			dialect: DIALECT,
			target: {
				schema: request.schema,
				name: request.name,
				columns: current.columns,
			},
			request,
			readOnlyConnection: connection.readOnly,
		});
	} finally {
		reserved.release();
	}
}
