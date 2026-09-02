import type { ColumnDescriptor } from "@datagripe/contracts";

/**
 * Export formats for the current result set (client-side; bounded by the server's QUERY_MAX_ROWS/QUERY_MAX_BYTES caps).
 * One format setting drives both download and clipboard — csv, json, tsv, markdown
 * (mocks/results-tab.html "Export and copy": one setting, two destinations).
 */

export type ExportFormat = "csv" | "json" | "tsv" | "markdown";

export const EXPORT_FORMATS: ExportFormat[] = [
	"csv",
	"json",
	"tsv",
	"markdown",
];

function csvCell(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	const text =
		typeof value === "object" ? JSON.stringify(value) : String(value);
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(columns: ColumnDescriptor[], rows: unknown[][]): string {
	const header = columns.map((column) => csvCell(column.name)).join(",");
	const body = rows.map((row) => row.map(csvCell).join(","));
	return `${[header, ...body].join("\r\n")}\r\n`;
}

export function toJson(columns: ColumnDescriptor[], rows: unknown[][]): string {
	const names = columns.map((column) => column.name);
	const objects = rows.map((row) =>
		Object.fromEntries(names.map((name, index) => [name, row[index]])),
	);
	return `${JSON.stringify(objects, null, 2)}\n`;
}

function tsvCell(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	const text =
		typeof value === "object" ? JSON.stringify(value) : String(value);
	return text.replaceAll("\t", " ").replaceAll("\n", " ");
}

export function toTsv(columns: ColumnDescriptor[], rows: unknown[][]): string {
	const header = columns.map((column) => tsvCell(column.name)).join("\t");
	const body = rows.map((row) => row.map(tsvCell).join("\t"));
	return `${[header, ...body].join("\n")}\n`;
}

function markdownCell(value: unknown): string {
	if (value === null || value === undefined) {
		return "NULL";
	}
	const text =
		typeof value === "object" ? JSON.stringify(value) : String(value);
	return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function toMarkdown(
	columns: ColumnDescriptor[],
	rows: unknown[][],
): string {
	const lines: string[] = [];
	const headerCells: string[] = [];
	for (const column of columns) {
		headerCells.push(markdownCell(column.name));
	}
	const separatorCells: string[] = [];
	for (const _column of columns) {
		separatorCells.push("---");
	}
	lines.push(`| ${headerCells.join(" | ")} |`);
	lines.push(`| ${separatorCells.join(" | ")} |`);
	for (const row of rows) {
		const cells: string[] = [];
		for (const value of row) {
			cells.push(markdownCell(value));
		}
		lines.push(`| ${cells.join(" | ")} |`);
	}
	return lines.join("\n");
}
export function downloadText(
	filename: string,
	text: string,
	mimeType: string,
): void {
	const blob = new Blob([text], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
