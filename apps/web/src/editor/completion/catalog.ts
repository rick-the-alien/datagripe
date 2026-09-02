import type { SchemaNode, SchemaPathSegment } from "@datagripe/contracts";
import { type WsRequestFn, wsClient } from "../../api/ws";

/**
 * Per-connection schema catalog cache powering SQL completion. Unlike the
 * explorer store this is a plain module: completions read it synchronously
 * and re-query Monaco on the next keystroke, so no reactive store is
 * needed. Table/view lists are fetched eagerly per schema; columns are
 * fetched on demand per table (schema.children is rate-limited at
 * 120 req/min) and in-flight requests are deduplicated.
 */

export type CatalogColumn = {
	name: string;
	dataType?: string | undefined;
	nullable?: boolean | undefined;
};

export type CatalogTable = {
	name: string;
	kind: "table" | "view";
	/** Undefined until fetched via ensureColumns. */
	columns?: CatalogColumn[] | undefined;
};

export type CatalogSchema = {
	tables: Map<string, CatalogTable>;
};

export type CatalogEntry = {
	status: "loading" | "ready" | "error";
	schemas: Map<string, CatalogSchema>;
};

export type CatalogListener = (connectionId: string) => void;

const MAX_CONCURRENT_REQUESTS = 6;

/** Schema catalog cache driving SQL completion for one or more connections. */
export interface Catalog {
	/** Kick off the catalog load for a connection; no-ops when cached. */
	ensureCatalog(connectionId: string): void;
	/** Fetch a table's columns on demand; cached and deduplicated. */
	ensureColumns(
		connectionId: string,
		schemaName: string,
		tableName: string,
	): void;
	/** Synchronous snapshot the completion provider reads. */
	getCatalog(connectionId: string): CatalogEntry | undefined;
	getColumns(
		connectionId: string,
		schemaName: string,
		tableName: string,
	): CatalogColumn[] | undefined;
	/** Locate a table by name across schemas (optionally pinned to one). */
	findTable(
		connectionId: string,
		tableName: string,
		schemaName?: string,
	): { schema: string; table: CatalogTable } | undefined;
	/** Fires when catalog or column data arrives for a connection. */
	subscribe(listener: CatalogListener): () => void;
}

export function createCatalog(request: WsRequestFn): Catalog {
	const catalogs = new Map<string, CatalogEntry>();
	const inflightColumns = new Set<string>();
	const listeners = new Set<CatalogListener>();

	// Tiny concurrency pool so a wide schema fan-out cannot burst the
	// rate-limited introspection endpoint.
	let active = 0;
	const queue: Array<() => void> = [];

	function runLimited<T>(task: () => Promise<T>): Promise<T> {
		if (active >= MAX_CONCURRENT_REQUESTS) {
			const { promise, resolve, reject } = Promise.withResolvers<T>();
			queue.push(() => {
				runLimited(task).then(resolve, reject);
			});
			return promise;
		}
		active += 1;
		return task().finally(() => {
			active -= 1;
			queue.shift()?.();
		});
	}

	async function fetchNodes(
		connectionId: string,
		path: SchemaPathSegment[],
	): Promise<SchemaNode[]> {
		const result = await runLimited(() =>
			request<{ nodes: SchemaNode[] }>("schema.children", {
				connectionId,
				path,
			}),
		);
		return result.nodes;
	}

	function notify(connectionId: string): void {
		for (const listener of listeners) {
			listener(connectionId);
		}
	}

	async function loadSchemaMembers(
		connectionId: string,
		schema: CatalogSchema,
		schemaName: string,
	): Promise<void> {
		const schemaSegment: SchemaPathSegment = {
			kind: "schema",
			name: schemaName,
		};
		try {
			const categories = await fetchNodes(connectionId, [schemaSegment]);
			await Promise.all(
				categories
					.filter((node) => node.kind === "tables" || node.kind === "views")
					.map(async (category) => {
						const members = await fetchNodes(connectionId, [
							schemaSegment,
							{ kind: category.kind, name: category.name },
						]);
						for (const member of members) {
							if (member.kind !== "table" && member.kind !== "view") {
								continue;
							}
							const existing = schema.tables.get(member.name);
							schema.tables.set(member.name, {
								name: member.name,
								kind: member.kind,
								columns: existing?.columns,
							});
						}
					}),
			);
		} catch {
			// A failing schema must not poison the rest of the catalog.
		} finally {
			notify(connectionId);
		}
	}

	async function loadCatalog(
		connectionId: string,
		entry: CatalogEntry,
	): Promise<void> {
		try {
			const nodes = await fetchNodes(connectionId, []);
			const schemaNames = nodes
				.filter((node) => node.kind === "schema")
				.map((node) => node.name);
			for (const name of schemaNames) {
				entry.schemas.set(name, { tables: new Map() });
			}
			notify(connectionId);
			await Promise.all(
				schemaNames.map((name) =>
					loadSchemaMembers(
						connectionId,
						entry.schemas.get(name) as CatalogSchema,
						name,
					),
				),
			);
			entry.status = "ready";
		} catch {
			entry.status = "error";
		} finally {
			notify(connectionId);
		}
	}

	return {
		ensureCatalog(connectionId: string): void {
			const existing = catalogs.get(connectionId);
			if (existing !== undefined && existing.status !== "error") {
				return;
			}
			const entry: CatalogEntry = { status: "loading", schemas: new Map() };
			catalogs.set(connectionId, entry);
			notify(connectionId);
			void loadCatalog(connectionId, entry);
		},

		ensureColumns(
			connectionId: string,
			schemaName: string,
			tableName: string,
		): void {
			const table = catalogs
				.get(connectionId)
				?.schemas.get(schemaName)
				?.tables.get(tableName);
			if (table === undefined || table.columns !== undefined) {
				return;
			}
			const key = `${connectionId}/${schemaName}/${tableName}`;
			if (inflightColumns.has(key)) {
				return;
			}
			inflightColumns.add(key);
			const categoryKind = table.kind === "table" ? "tables" : "views";
			const path: SchemaPathSegment[] = [
				{ kind: "schema", name: schemaName },
				{ kind: categoryKind, name: categoryKind },
				{ kind: table.kind, name: tableName },
			];
			void fetchNodes(connectionId, path)
				.then((nodes) => {
					table.columns = nodes
						.filter((node) => node.kind === "column")
						.map((node) => ({
							name: node.name,
							dataType: node.dataType,
							nullable: node.nullable,
						}));
				})
				.catch(() => {
					// Leave columns undefined so a later keystroke retries.
				})
				.finally(() => {
					inflightColumns.delete(key);
					notify(connectionId);
				});
		},

		getCatalog(connectionId: string): CatalogEntry | undefined {
			return catalogs.get(connectionId);
		},

		getColumns(
			connectionId: string,
			schemaName: string,
			tableName: string,
		): CatalogColumn[] | undefined {
			return catalogs
				.get(connectionId)
				?.schemas.get(schemaName)
				?.tables.get(tableName)?.columns;
		},

		findTable(
			connectionId: string,
			tableName: string,
			schemaName?: string,
		): { schema: string; table: CatalogTable } | undefined {
			const entry = catalogs.get(connectionId);
			if (entry === undefined) {
				return undefined;
			}
			if (schemaName !== undefined) {
				const table = entry.schemas.get(schemaName)?.tables.get(tableName);
				return table === undefined ? undefined : { schema: schemaName, table };
			}
			for (const [name, schema] of entry.schemas) {
				const table = schema.tables.get(tableName);
				if (table !== undefined) {
					return { schema: name, table };
				}
			}
			return undefined;
		},

		subscribe(listener: CatalogListener): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

export const catalog = createCatalog(wsClient.request);
