import type { ColumnDescriptor } from "@datagripe/contracts";

/**
 * CSV/JSON export of the currently loaded result set (client-side;
 * bounded by the server's QUERY_MAX_ROWS/QUERY_MAX_BYTES caps).
 */

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
