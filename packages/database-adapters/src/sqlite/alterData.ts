import type { ObjectAlterResult } from "@datagripe/contracts";
import type { SQL } from "bun";
import { SQLITE_ALTER } from "../object/alter";
import { applyColumnChanges } from "../object/applyAlter";
import { SQLITE_TABLE_DIALECT } from "../table/builder";
import type { ObjectAlterExecution, ResolvedConnection } from "../types";
import { describeSqliteObject } from "./objectData";

/**
 * SQLite column changes (docs/spec/object-view.md). Only add, rename and
 * drop exist; anything else needs the table rebuilt, and the builder
 * refuses it by name rather than emitting SQL SQLite will reject.
 */

const DIALECT = { ...SQLITE_TABLE_DIALECT, ...SQLITE_ALTER };

export async function alterSqliteColumns(
	client: SQL,
	connection: ResolvedConnection,
	request: ObjectAlterExecution,
): Promise<ObjectAlterResult> {
	const current = await describeSqliteObject(client, {
		schema: request.schema,
		name: request.name,
		kind: "table",
	});

	const run = async (sql: string) => {
		await client.unsafe(sql);
	};
	return applyColumnChanges({
		session: {
			// SQLite does roll DDL back inside a transaction.
			transactional: true,
			execute: run,
			begin: () => run("BEGIN"),
			commit: () => run("COMMIT"),
			rollback: () => run("ROLLBACK"),
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
}
