import type { ColumnDescriptor } from "@datagripe/contracts";
import { useEffect, useRef, useState } from "react";
import {
	downloadText,
	EXPORT_FORMATS,
	type ExportFormat,
	toCsv,
	toJson,
	toMarkdown,
	toTsv,
} from "../utils/export";

/**
 * The joined export group from docs/brand/mocks/results-tab.html
 * ("Export and copy"): one format setting drives both destinations, and
 * the choice is remembered. Shared by the results panel and the table
 * view — the same control on both surfaces, not two that drift.
 */

const FORMAT_STORAGE_KEY = "dg.exportFormat";

const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
	csv: "csv",
	json: "json",
	tsv: "tsv",
	markdown: "md",
};

const FORMAT_MIMES: Record<ExportFormat, string> = {
	csv: "text/csv",
	json: "application/json",
	tsv: "text/tab-separated-values",
	markdown: "text/markdown",
};

export function formatResultSet(
	format: ExportFormat,
	columns: ColumnDescriptor[],
	rows: unknown[][],
): string {
	switch (format) {
		case "json":
			return toJson(columns, rows);
		case "tsv":
			return toTsv(columns, rows);
		case "markdown":
			return toMarkdown(columns, rows);
		default:
			return toCsv(columns, rows);
	}
}

function readFormat(): ExportFormat {
	try {
		const value = localStorage.getItem(FORMAT_STORAGE_KEY);
		return EXPORT_FORMATS.includes(value as ExportFormat)
			? (value as ExportFormat)
			: "csv";
	} catch {
		return "csv";
	}
}

export function ExportControls(props: {
	columns: ColumnDescriptor[];
	/** Called on demand so a large grid is only serialised when asked. */
	rows: () => unknown[][];
	/** Basename for the download; the extension follows the format. */
	filename: string;
}) {
	const [format, setFormat] = useState<ExportFormat>(readFormat);
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!menuOpen) {
			return;
		}
		const onPointerDown = (event: MouseEvent) => {
			if (menuRef.current?.contains(event.target as Node) === true) {
				return;
			}
			setMenuOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setMenuOpen(false);
			}
		};
		window.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [menuOpen]);

	if (props.columns.length === 0) {
		return null;
	}

	return (
		<div className="dg-exp">
			<button
				type="button"
				className="dg-exp-eb"
				title={`Download ${format}`}
				onClick={() => {
					downloadText(
						`${props.filename}.${FORMAT_EXTENSIONS[format]}`,
						formatResultSet(format, props.columns, props.rows()),
						FORMAT_MIMES[format],
					);
				}}
			>
				⬇
			</button>
			<button
				type="button"
				className="dg-exp-eb"
				title={`Copy ${format}`}
				onClick={() => {
					void navigator.clipboard.writeText(
						formatResultSet(format, props.columns, props.rows()),
					);
				}}
			>
				⧉
			</button>
			<div className="dg-exp-ec-wrap" ref={menuRef}>
				<button
					type="button"
					className="dg-exp-ec"
					aria-expanded={menuOpen}
					aria-label="Format"
					title={`Format: ${format}`}
					onClick={() => setMenuOpen((current) => !current)}
				>
					▾
				</button>
				{menuOpen && (
					<div className="dg-exp-fmt dg-scroll" role="menu">
						<div className="dg-exp-fmt-hd">format for both</div>
						{EXPORT_FORMATS.map((value) => (
							<button
								key={value}
								type="button"
								role="menuitem"
								className="dg-exp-fmt-it"
								onClick={() => {
									setFormat(value);
									setMenuOpen(false);
									try {
										localStorage.setItem(FORMAT_STORAGE_KEY, value);
									} catch {
										// Storage blocked — format stays per-session.
									}
								}}
							>
								<span className="dg-exp-fmt-tick">
									{value === format ? "✓" : ""}
								</span>
								{value}
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
