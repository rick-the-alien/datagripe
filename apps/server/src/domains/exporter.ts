import type {
	Domain,
	DomainManifest,
	DomainTarget,
	ExportPlan,
	ExportPlanEntry,
} from "@datagripe/contracts";
import { domainTargetKey } from "@datagripe/contracts";
import { objectDirectory, objectFileName, UnsafePathError } from "./paths";

/**
 * Building the export tree (docs/spec/domains.md "Export").
 *
 * Split from the filesystem on purpose: this module turns domains, tags
 * and catalog reads into a `path -> contents` map, and `writer.ts` puts
 * it on disk. That is what makes the determinism rules testable without
 * a temporary directory — the property that matters is that two runs
 * over an unchanged database produce identical *bytes*, and that is a
 * property of this map.
 *
 * Every rule below exists so `git diff` is empty when nothing changed:
 *
 * - domains in name order, objects in `(schema, name, kind)` order;
 * - no timestamps, hostnames, server versions, row counts, sizes or oids
 *   in any generated body (`statistics` is live data and is never
 *   exported);
 * - the manifest serialised with sorted keys and two-space indent;
 * - every file ending in exactly one newline;
 * - data rows ordered by primary key, and a table without one refused
 *   rather than written in whatever order the engine felt like.
 */

export interface ObjectDdl {
	ddl: string | null;
	/** Primary-key columns, in order. Empty when there is none. */
	primaryKey: string[];
	/** Every column, for the INSERT column list. */
	columns: string[];
}

export interface DataPage {
	columns: string[];
	rows: unknown[][];
	/** True when the read hit the cap, which refuses the table. */
	overflowed: boolean;
}

export interface ExportSource {
	connectionRef: string;
	connectionName: string;
	engine: string;
	maxDataRows: number;
	describe: (target: DomainTarget) => Promise<ObjectDdl>;
	/** `kind:schema.name` to canonical GRANT lines. */
	grants: Map<string, string[]>;
	/** Only called for `includeData` domains, and only for tables. */
	readData: (
		target: DomainTarget,
		orderBy: string[],
		limit: number,
	) => Promise<DataPage>;
	/** The `access/` files, already rendered. Empty when unavailable. */
	accessFiles: Map<string, string>;
	/** Objects the datasource reports that carry no tag. */
	untaggedCount: number;
}

export interface BuiltExport {
	/** Relative path (forward-slashed) to file contents. */
	files: Map<string, string>;
	refusals: ExportPlanEntry[];
	domainCount: number;
	objectCount: number;
	untaggedCount: number;
}

/** One trailing newline, never zero and never two. */
function terminate(body: string): string {
	return `${body.replace(/\n+$/, "")}\n`;
}

/**
 * A SQL literal for a data dump. Deliberately narrow: anything that is
 * not a primitive is rendered as a quoted JSON string, which round-trips
 * through `jsonb`/`json` columns and is at least honest about what it is
 * for everything else.
 */
export function sqlLiteral(value: unknown): string {
	if (value === null || value === undefined) {
		return "NULL";
	}
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? String(value) : "NULL";
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (value instanceof Date) {
		return `'${value.toISOString()}'`;
	}
	const text =
		typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
	return `'${text.replaceAll("'", "''")}'`;
}

function quoteIdent(name: string): string {
	return /^[a-z_][a-z0-9_]*$/.test(name)
		? name
		: `"${name.replaceAll('"', '""')}"`;
}

function qualified(target: DomainTarget): string {
	if (target.kind === "function" || target.kind === "procedure") {
		// The name already carries its identity arguments, so it cannot be
		// quoted wholesale.
		return `${quoteIdent(target.schema)}.${target.name}`;
	}
	return `${quoteIdent(target.schema)}.${quoteIdent(target.name)}`;
}

/**
 * The body of one object's file: its DDL, then its grants.
 *
 * The grant block is not decoration. Under PostgREST a `CREATE FUNCTION`
 * without one tells a reviewer nothing about whether the function is an
 * endpoint, and the `PUBLIC` line the adapter emits for a NULL `proacl`
 * is the whole reason the block is here.
 */
export function objectFileBody(
	target: DomainTarget,
	ddl: string | null,
	grants: string[],
): string {
	const parts: string[] = [];
	parts.push(
		ddl === null
			? `-- ${qualified(target)}: this engine did not report a definition.`
			: ddl.trimEnd(),
	);
	parts.push("");
	if (grants.length === 0) {
		// Absence and silence are different (object-view spec, "Three kinds
		// of nothing"). An empty grant block would read as "not checked".
		parts.push("-- No grants beyond the owner.");
	} else {
		parts.push(...grants);
	}
	return terminate(parts.join("\n"));
}

export function dataFileBody(target: DomainTarget, page: DataPage): string {
	const table = qualified(target);
	const columns = page.columns.map(quoteIdent).join(", ");
	const lines = [
		`-- Data for ${table}, ordered by primary key.`,
		"",
		...page.rows.map(
			(row) =>
				`INSERT INTO ${table} (${columns}) VALUES (${row
					.map(sqlLiteral)
					.join(", ")});`,
		),
	];
	return terminate(lines.join("\n"));
}

/**
 * `manifest.json` — the round-trip source of truth, and the only file
 * the import reads. Sorted keys, two-space indent, trailing newline. It
 * is committed to a repository, so it carries no host, no port, no user
 * and no credential of any kind.
 */
export function renderManifest(manifest: DomainManifest): string {
	return `${JSON.stringify(manifest, sortedKeys, 2)}\n`;
}

function sortedKeys(_key: string, value: unknown): unknown {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value instanceof Date
	) {
		return value;
	}
	const entries = Object.entries(value as Record<string, unknown>).sort(
		([a], [b]) => a.localeCompare(b),
	);
	return Object.fromEntries(entries);
}

function sortTargets(targets: DomainTarget[]): DomainTarget[] {
	return [...targets].sort(
		(a, b) =>
			a.schema.localeCompare(b.schema) ||
			a.name.localeCompare(b.name) ||
			a.kind.localeCompare(b.kind),
	);
}

export async function buildExport(
	domains: Domain[],
	tagsByDomain: Map<string, DomainTarget[]>,
	source: ExportSource,
	onProgress?: (done: number, total: number, current: string) => void,
): Promise<BuiltExport> {
	const files = new Map<string, string>();
	const refusals: ExportPlanEntry[] = [];
	const ordered = [...domains].sort((a, b) => a.name.localeCompare(b.name));

	const total = [...tagsByDomain.values()].reduce(
		(sum, targets) => sum + targets.length,
		0,
	);
	let done = 0;
	let objectCount = 0;

	const manifestDomains: DomainManifest["domains"] = [];

	for (const domain of ordered) {
		const targets = sortTargets(tagsByDomain.get(domain.id) ?? []);
		manifestDomains.push({
			name: domain.name,
			colour: domain.colour,
			description: domain.description,
			includeData: domain.includeData,
			objects: targets,
		});

		for (const target of targets) {
			done += 1;
			onProgress?.(done, total, `${target.schema}.${target.name}`);
			const directory = objectDirectory(target.kind);
			let fileName: string;
			try {
				fileName = objectFileName(target.kind, target.schema, target.name);
			} catch (error) {
				// A schema or object name that is not a plain filename. The
				// database may not be ours; a name of `../../etc` gets a refusal
				// line, not a write.
				refusals.push({
					path: `domains/${domain.name}/${directory}/?`,
					action: "refused",
					reason:
						error instanceof UnsafePathError
							? `Unsafe object name: ${target.schema}.${target.name}`
							: `Cannot name a file for ${target.schema}.${target.name}`,
				});
				continue;
			}
			const relative = `domains/${domain.name}/${directory}/${fileName}`;

			let described: ObjectDdl;
			try {
				described = await source.describe(target);
			} catch (error) {
				refusals.push({
					path: relative,
					action: "refused",
					reason: error instanceof Error ? error.message : "Describe failed",
				});
				continue;
			}
			files.set(
				relative,
				objectFileBody(
					target,
					described.ddl,
					source.grants.get(domainTargetKey(target)) ?? [],
				),
			);
			objectCount += 1;

			if (!domain.includeData || target.kind !== "table") {
				continue;
			}
			if (described.primaryKey.length === 0) {
				// Unstable ordering would put a thousand-line diff in front of
				// you on every pull, so this refuses rather than exports.
				refusals.push({
					path: `domains/${domain.name}/data/${fileName}`,
					action: "refused",
					reason: `${target.schema}.${target.name} has no primary key, so row order would churn every export`,
				});
				continue;
			}
			try {
				const page = await source.readData(
					target,
					described.primaryKey,
					source.maxDataRows,
				);
				if (page.overflowed) {
					// A truncated file that looks complete is worse than no file.
					refusals.push({
						path: `domains/${domain.name}/data/${fileName}`,
						action: "refused",
						reason: `${target.schema}.${target.name} is over the ${source.maxDataRows}-row data cap`,
					});
					continue;
				}
				files.set(
					`domains/${domain.name}/data/${fileName}`,
					dataFileBody(target, page),
				);
			} catch (error) {
				refusals.push({
					path: `domains/${domain.name}/data/${fileName}`,
					action: "refused",
					reason: error instanceof Error ? error.message : "Data read failed",
				});
			}
		}
	}

	for (const [name, contents] of source.accessFiles) {
		files.set(`access/${name}`, terminate(contents));
	}

	files.set(
		"manifest.json",
		renderManifest({
			version: 1,
			connection: {
				ref: source.connectionRef,
				name: source.connectionName,
				engine: source.engine,
			},
			domains: manifestDomains,
		}),
	);

	return {
		files,
		refusals,
		domainCount: ordered.length,
		objectCount,
		untaggedCount: source.untaggedCount,
	};
}

/** Empty plan totals, so a caller never has to build one by hand. */
export function emptyPlan(root: string, dryRun: boolean): ExportPlan {
	return {
		root,
		entries: [],
		domainCount: 0,
		objectCount: 0,
		untaggedCount: 0,
		written: 0,
		unchanged: 0,
		deleted: 0,
		refused: 0,
		dryRun,
	};
}
