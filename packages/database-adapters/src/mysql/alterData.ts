import type { ObjectAlterResult } from "@datagripe/contracts";
import type { SQL } from "bun";
import { MYSQL_ALTER } from "../object/alter";
import { applyColumnChanges } from "../object/applyAlter";
import { MYSQL_TABLE_DIALECT } from "../table/builder";
import type {
	ObjectAlterExecution,
	ResolvedConnection,
	TableLimits,
} from "../types";
import { describeMysqlObject } from "./objectData";

/**
 * MySQL column changes (docs/spec/object-view.md). MySQL commits each
 * DDL statement implicitly, so a batch is not atomic — applyColumnChanges
 * reports how far it got rather than implying a rollback that did not
 * happen.
 */

const DIALECT = { ...MYSQL_TABLE_DIALECT, ...MYSQL_ALTER };

export async function alterMysqlColumns(
	client: SQL,
	connection: ResolvedConnection,
	request: ObjectAlterExecution,
	limits: TableLimits,
): Promise<ObjectAlterResult> {
	// MODIFY COLUMN restates the whole definition, so the current shape is
	// not optional here — it is what keeps an unrelated attribute.
	const current = await describeMysqlObject(
		client,
		{ schema: request.schema, name: request.name, kind: "table" },
		limits,
	);

	const reserved = await client.reserve();
	try {
		await reserved.unsafe(
			`SET SESSION max_execution_time = ${Math.max(
				1,
				Math.floor(limits.timeoutMs),
			)}`,
		);
		return await applyColumnChanges({
			session: {
				transactional: false,
				execute: async (sql) => {
					await reserved.unsafe(sql);
				},
				// DDL is auto-committing here; opening a transaction would be
				// theatre, so the session is honest about not having one.
				begin: async () => {},
				commit: async () => {},
				rollback: async () => {},
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
