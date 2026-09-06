import type { ObjectColumn, ObjectConstraint } from "@datagripe/contracts";

/**
 * Presentation helpers shared by the object-view adapters
 * (docs/spec/object-view.md). Formatting lives on the server so the
 * three engines agree on what "1.2 GB" means, and so the client renders
 * strings rather than re-deriving units per tab.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number | null | undefined): string | null {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
		return null;
	}
	if (bytes < 1024) {
		return `${Math.round(bytes)} B`;
	}
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	// One decimal below 10 so 1.2 GB stays 1.2 GB and 512 MB stays 512 MB.
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

export function formatCount(value: number | null | undefined): string | null {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return null;
	}
	return Math.round(value).toLocaleString("en-US");
}

/** "4h ago", or null when the timestamp is missing. */
export function formatAgo(
	value: string | Date | null | undefined,
	now: number = Date.now(),
): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	const at =
		value instanceof Date ? value.getTime() : Date.parse(String(value));
	if (!Number.isFinite(at)) {
		return null;
	}
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 90) {
		return `${seconds}s ago`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) {
		return `${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 48) {
		return `${hours}h ago`;
	}
	return `${Math.round(hours / 24)}d ago`;
}

/** Drops null-valued tiles so a tab shows what exists, not what doesn't. */
export function statTiles(
	entries: Array<[string, string | null]>,
): Array<{ label: string; value: string }> {
	const tiles: Array<{ label: string; value: string }> = [];
	for (const [label, value] of entries) {
		if (value !== null) {
			tiles.push({ label, value });
		}
	}
	return tiles;
}

/**
 * Rebuild a `CREATE TABLE` from catalog rows. PostgreSQL has no
 * server-side DDL export — `pg_dump` is a client program, not a
 * function — so the object view reconstructs it and flags the result as
 * reconstructed rather than passing off an approximation as verbatim.
 */
export function reconstructCreateTable(options: {
	quote: (identifier: string) => string;
	schema: string;
	name: string;
	columns: ObjectColumn[];
	/** Table-level constraints, already rendered by the engine. */
	constraints: ObjectConstraint[];
	/** Standalone index statements to append. */
	indexStatements: string[];
	/**
	 * Columns whose `defaultExpr` is a bare column clause rather than a
	 * DEFAULT — PostgreSQL identity columns spell themselves
	 * `generated always as identity`, which does not take the keyword.
	 */
	bareDefaults?: ReadonlySet<string>;
}): string {
	const { quote } = options;
	const width = Math.max(
		...options.columns.map((column) => quote(column.name).length),
		0,
	);
	const bare = options.bareDefaults ?? new Set<string>();
	const lines = options.columns.map((column) => {
		const parts = [
			quote(column.name).padEnd(width),
			column.dataType,
			column.nullable ? "" : "not null",
			column.defaultExpr === null
				? ""
				: bare.has(column.name)
					? column.defaultExpr
					: `default ${column.defaultExpr}`,
		].filter((part) => part !== "");
		return `  ${parts.join(" ")}`;
	});
	for (const constraint of options.constraints) {
		lines.push(
			`  constraint ${quote(constraint.name)} ${constraint.definition}`,
		);
	}
	const create = `create table ${quote(options.schema)}.${quote(
		options.name,
	)} (\n${lines.join(",\n")}\n);`;
	return [create, ...options.indexStatements].join("\n\n");
}
