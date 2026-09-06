import type { ObjectAlterResult, ObjectColumn } from "@datagripe/contracts";
import { TableRequestError } from "../table/builder";
import type { ObjectAlterExecution } from "../types";
import type { AlterDialect, AlterTarget } from "./alter";
import { alterStatements } from "./alter";

/**
 * Apply a column-change batch (docs/spec/object-view.md). Shared across
 * engines: the only per-engine parts are the dialect and how a
 * transaction is opened, both handed in.
 *
 * A dry run builds the statements and stops. That is the preview the
 * object view shows, and because it is the same code path, the SQL shown
 * is the SQL that runs.
 */

export interface AlterSession {
	/** Run one DDL statement. */
	execute: (sql: string) => Promise<void>;
	/** Open a transaction, or a no-op where DDL is not transactional. */
	begin: () => Promise<void>;
	commit: () => Promise<void>;
	rollback: () => Promise<void>;
	/** True when this engine rolls DDL back; false makes the failure
	 * message honest about partial application. */
	readonly transactional: boolean;
}

export async function applyColumnChanges(options: {
	session: AlterSession;
	dialect: AlterDialect;
	target: AlterTarget;
	request: ObjectAlterExecution;
	readOnlyConnection: boolean;
}): Promise<ObjectAlterResult> {
	const { session, dialect, target, request } = options;

	if (target.columns.length === 0) {
		throw new TableRequestError(
			`'${target.schema}.${target.name}' was not found`,
		);
	}
	const statements = alterStatements(dialect, target, request.changes);

	if (request.dryRun) {
		return { statements, applied: 0 };
	}
	if (options.readOnlyConnection) {
		throw new TableRequestError("This datasource is read-only");
	}

	await session.begin();
	let applied = 0;
	try {
		for (const statement of statements) {
			await session.execute(statement);
			applied += 1;
		}
		await session.commit();
		return { statements, applied };
	} catch (error) {
		await session.rollback().catch(() => {});
		const message = error instanceof Error ? error.message : String(error);
		if (session.transactional || applied === 0) {
			throw error instanceof Error ? error : new Error(message);
		}
		// MySQL commits each DDL statement implicitly, so a mid-batch
		// failure leaves the earlier ones in place. Saying so is the
		// difference between a confusing schema and a known one.
		throw new TableRequestError(
			`${message} — this engine does not roll DDL back, so the first ${applied} of ${statements.length} statements were applied. Refresh to see the current shape.`,
		);
	}
}

/** Columns as the alter builders need them, from a describe result. */
export function alterTargetOf(
	schema: string,
	name: string,
	columns: ObjectColumn[],
): AlterTarget {
	return { schema, name, columns };
}
