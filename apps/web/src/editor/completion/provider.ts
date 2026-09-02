import { statementAt } from "@datagripe/sql-tools";
import * as monaco from "monaco-editor";
import { useDocumentsStore } from "../../stores/documents";
import { refToConnectionId } from "../../stores/executions";
import { useSessionStore } from "../../stores/session";
import { type Catalog, type CatalogTable, catalog } from "./catalog";
import { completionContext, parseStatementTables } from "./context";
import { SQL_FUNCTIONS, SQL_KEYWORDS } from "./keywords";

/**
 * DataGrip-style schema-aware SQL completion. Reads the catalog cache
 * synchronously; when catalog or column data is still in flight it
 * returns what exists and Monaco re-queries on the next keystroke (the
 * catalog's subscribe seam notifies listeners as data arrives).
 */

const KIND = monaco.languages.CompletionItemKind;

/** sortText prefixes: aliases/columns first, keywords last. */
const SORT = {
	alias: "1",
	column: "2",
	table: "3",
	schema: "4",
	function: "5",
	keyword: "6",
} as const;

function tableKind(table: CatalogTable): monaco.languages.CompletionItemKind {
	return table.kind === "view" ? KIND.Interface : KIND.Class;
}

export function registerSqlCompletion(
	catalogInstance: Catalog = catalog,
): monaco.IDisposable {
	function keywordItems(
		range: monaco.IRange,
	): monaco.languages.CompletionItem[] {
		return [
			...SQL_KEYWORDS.map((keyword) => ({
				label: keyword,
				kind: KIND.Keyword,
				insertText: keyword,
				range,
				sortText: `${SORT.keyword}${keyword}`,
			})),
			...SQL_FUNCTIONS.map((fn) => ({
				label: fn,
				kind: KIND.Function,
				insertText: fn,
				range,
				sortText: `${SORT.function}${fn}`,
			})),
		];
	}

	function tableItems(
		connectionId: string,
		range: monaco.IRange,
		includeSchemas: boolean,
	): monaco.languages.CompletionItem[] {
		const entry = catalogInstance.getCatalog(connectionId);
		if (entry === undefined) {
			return [];
		}
		const items: monaco.languages.CompletionItem[] = [];
		for (const [schemaName, schema] of entry.schemas) {
			if (includeSchemas) {
				items.push({
					label: schemaName,
					kind: KIND.Module,
					insertText: schemaName,
					range,
					sortText: `${SORT.schema}${schemaName}`,
				});
			}
			for (const table of schema.tables.values()) {
				items.push({
					label: table.name,
					kind: tableKind(table),
					detail: `${table.kind} — ${schemaName}`,
					insertText: table.name,
					range,
					sortText: `${SORT.table}${table.name}`,
				});
				if (schemaName !== "public") {
					const qualified = `${schemaName}.${table.name}`;
					items.push({
						label: qualified,
						kind: tableKind(table),
						detail: `${table.kind} — ${schemaName}`,
						insertText: qualified,
						range,
						sortText: `${SORT.table}${qualified}`,
					});
				}
			}
		}
		return items;
	}

	function columnItems(
		connectionId: string,
		schemaName: string,
		table: CatalogTable,
		range: monaco.IRange,
	): monaco.languages.CompletionItem[] {
		// Lazy, rate-limit-friendly: fetch on demand, complete with what is
		// cached now; the next keystroke picks up arrived columns.
		catalogInstance.ensureColumns(connectionId, schemaName, table.name);
		return (table.columns ?? []).map((column) => ({
			label: column.name,
			kind: KIND.Field,
			...(column.dataType !== undefined ? { detail: column.dataType } : {}),
			insertText: column.name,
			range,
			sortText: `${SORT.column}${column.name}`,
		}));
	}

	return monaco.languages.registerCompletionItemProvider("sql", {
		triggerCharacters: ["."],
		provideCompletionItems(model, position) {
			const word = model.getWordUntilPosition(position);
			const range = new monaco.Range(
				position.lineNumber,
				word.startColumn,
				position.lineNumber,
				word.endColumn,
			);

			// datagripe://document/<id>.sql parses with authority="document";
			// the document id is the path minus the .sql suffix.
			const documentId =
				model.uri.scheme === "datagripe" && model.uri.authority === "document"
					? /^\/(.+)\.sql$/.exec(model.uri.path)?.[1]
					: undefined;
			const connectionId =
				documentId === undefined
					? undefined
					: (useDocumentsStore.getState().prefs[documentId]
							?.defaultConnectionId ??
						refToConnectionId(
							useSessionStore.getState().currentWorkspace
								?.defaultConnectionRef ?? null,
						));
			if (connectionId !== undefined) {
				catalogInstance.ensureCatalog(connectionId);
			}

			const text = model.getValue();
			const statement = statementAt(text, model.getOffsetAt(position));
			const statementText = statement?.text ?? "";
			const beforeCursor =
				statement === null
					? ""
					: statement.text.slice(
							0,
							Math.max(0, model.getOffsetAt(position) - statement.start),
						);
			const context = completionContext(beforeCursor, statementText);
			const { tables, aliasToTable } = parseStatementTables(statementText);

			if (connectionId === undefined) {
				return { suggestions: keywordItems(range) };
			}

			if (context.kind === "dot") {
				const { qualifier } = context;
				// Alias/table column completion first, but fall through when the
				// qualifier names no known table — `FROM shop.` parses "shop" as
				// a table reference while the user is mid-way through schema.table.
				const viaAlias = aliasToTable.get(qualifier);
				const viaAliasFound =
					viaAlias === undefined
						? undefined
						: catalogInstance.findTable(
								connectionId,
								viaAlias.name,
								viaAlias.schema,
							);
				if (viaAliasFound !== undefined) {
					return {
						suggestions: columnItems(
							connectionId,
							viaAliasFound.schema,
							viaAliasFound.table,
							range,
						),
					};
				}
				const entry = catalogInstance.getCatalog(connectionId);
				const schema = entry?.schemas.get(qualifier);
				if (schema !== undefined) {
					return {
						suggestions: [...schema.tables.values()].map((table) => ({
							label: table.name,
							kind: tableKind(table),
							detail: table.kind,
							insertText: table.name,
							range,
							sortText: `${SORT.table}${table.name}`,
						})),
					};
				}
				const found = catalogInstance.findTable(connectionId, qualifier);
				if (found !== undefined) {
					return {
						suggestions: columnItems(
							connectionId,
							found.schema,
							found.table,
							range,
						),
					};
				}
				return { suggestions: [] };
			}

			if (context.kind === "tablePosition") {
				return {
					suggestions: [
						...tableItems(connectionId, range, true),
						...keywordItems(range),
					],
				};
			}

			// General position: aliases in scope, columns of tables in scope,
			// tables, then keywords/functions.
			const suggestions: monaco.languages.CompletionItem[] = [];
			for (const [alias] of aliasToTable) {
				suggestions.push({
					label: alias,
					kind: KIND.Variable,
					insertText: alias,
					range,
					sortText: `${SORT.alias}${alias}`,
				});
			}
			const seenColumns = new Set<string>();
			for (const table of tables) {
				const found = catalogInstance.findTable(
					connectionId,
					table.name,
					table.schema,
				);
				if (found === undefined) {
					continue;
				}
				for (const item of columnItems(
					connectionId,
					found.schema,
					found.table,
					range,
				)) {
					const label = String(item.label);
					if (seenColumns.has(label)) {
						continue;
					}
					seenColumns.add(label);
					suggestions.push(item);
				}
			}
			suggestions.push(...tableItems(connectionId, range, false));
			suggestions.push(...keywordItems(range));
			return { suggestions };
		},
	});
}
