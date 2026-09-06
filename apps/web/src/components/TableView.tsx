import type {
	CellInput,
	TableColumn,
	TableRowsResult,
	TableSort,
} from "@datagripe/contracts";
import { ADAPTER_CAPABILITIES } from "@datagripe/contracts";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { wsClient } from "../api/ws";
import { readViewPanelParams } from "../app/viewPanels";
import { useConnectionsStore } from "../stores/runtime";
import { useSessionStore } from "../stores/session";
import { ExportControls } from "./ExportControls";
import {
	buildEdits,
	cellDetail,
	cellDisplay,
	isDirty,
	NO_PENDING_EDITS,
	type PendingEdits,
	pendingCell,
	pendingCount,
	withCellEdit,
	withDeleteToggled,
	withInsertCellEdit,
	withNewRow,
	withoutInsert,
} from "./tableEdits";

/**
 * Table view (docs/spec/table-view.md, brand-system.md "Table view — the
 * data"). One line of chrome, then rows all the way down: real estate
 * goes to data.
 *
 * The grid is the whole surface, so everything that is a mode rather
 * than a constant — transpose, the value panel, row insert/delete —
 * lives in the overflow menu, and the commit/revert pair only appears
 * while there is something to commit.
 */

const ROW_LIMITS = [100, 200, 500, 1_000] as const;

/** A focused cell, in either the fetched page or a draft insert row. */
type Focus = {
	kind: "row" | "insert";
	index: number;
	column: string;
};

function sortDirection(
	sort: TableSort[],
	column: string,
): "asc" | "desc" | undefined {
	return sort.find((term) => term.column === column)?.direction;
}

/**
 * Click cycles asc → desc → unsorted, replacing the sort. Shift-click
 * appends instead, so a second key can be added without losing the
 * first.
 */
function nextSort(
	sort: TableSort[],
	column: string,
	append: boolean,
): TableSort[] {
	const current = sortDirection(sort, column);
	const rest = append ? sort.filter((term) => term.column !== column) : [];
	if (current === undefined) {
		return [...rest, { column, direction: "asc" }];
	}
	if (current === "asc") {
		return [...rest, { column, direction: "desc" }];
	}
	return rest;
}

function numberFormat(value: number): string {
	return value.toLocaleString();
}

/** `100 of 41,203,882 rows`, per the brand spec's footer. */
function rowCountLabel(data: TableRowsResult, shown: number): string {
	if (data.totalRows === null) {
		return `${numberFormat(shown)} rows`;
	}
	const total = `${data.estimated ? "~" : ""}${numberFormat(data.totalRows)}`;
	return `${numberFormat(shown)} of ${total} rows`;
}

function OverflowMenu(props: {
	transposed: boolean;
	panelOpen: boolean;
	canEdit: boolean;
	onToggleTranspose: () => void;
	onTogglePanel: () => void;
	onInsertRow: () => void;
	onDeleteRow: () => void;
	deleteEnabled: boolean;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (event: MouseEvent) => {
			if (rootRef.current?.contains(event.target as Node) === true) {
				return;
			}
			setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
			}
		};
		window.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const item = (
		label: string,
		onClick: () => void,
		options?: { ticked?: boolean; disabled?: boolean; danger?: boolean },
	) => (
		<button
			key={label}
			type="button"
			role="menuitem"
			className={
				options?.danger === true
					? "dg-exp-fmt-it dg-context-danger"
					: "dg-exp-fmt-it"
			}
			disabled={options?.disabled === true}
			onClick={() => {
				setOpen(false);
				onClick();
			}}
		>
			<span className="dg-exp-fmt-tick">
				{options?.ticked === true ? "✓" : ""}
			</span>
			{label}
		</button>
	);

	return (
		<div className="dg-exp-ec-wrap" ref={rootRef}>
			<button
				type="button"
				className="dg-tv-ico"
				aria-expanded={open}
				aria-label="More"
				title="More"
				onClick={() => setOpen((value) => !value)}
			>
				⋯
			</button>
			{open && (
				<div className="dg-exp-fmt dg-tv-more dg-scroll" role="menu">
					{item("transpose", props.onToggleTranspose, {
						ticked: props.transposed,
					})}
					{item("value panel", props.onTogglePanel, {
						ticked: props.panelOpen,
					})}
					<div className="dg-context-separator" />
					{item("insert row", props.onInsertRow, { disabled: !props.canEdit })}
					{item("delete row", props.onDeleteRow, {
						disabled: !props.canEdit || !props.deleteEnabled,
						danger: true,
					})}
				</div>
			)}
		</div>
	);
}

/**
 * The editable cell body: display text until it is being edited. The
 * button — not the surrounding cell — carries selection and the
 * keyboard path, so the grid is navigable without a mouse.
 */
function CellBody(props: {
	value: unknown;
	pending: CellInput | undefined;
	editing: boolean;
	editable: boolean;
	onFocus: () => void;
	onStartEdit: () => void;
	onCommit: (value: CellInput) => void;
	onCancel: () => void;
}) {
	const shown =
		props.pending === undefined
			? cellDisplay(props.value)
			: props.pending.kind === "null"
				? { text: "NULL", isNull: true }
				: props.pending.kind === "default"
					? { text: "DEFAULT", isNull: true }
					: { text: props.pending.text, isNull: false };

	const [draft, setDraft] = useState(shown.isNull ? "" : shown.text);
	const inputRef = useRef<HTMLInputElement | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the draft is seeded once per edit session, not tracked
	useEffect(() => {
		if (props.editing) {
			setDraft(shown.isNull ? "" : shown.text);
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [props.editing]);

	if (props.editing) {
		return (
			<input
				ref={inputRef}
				className="dg-tv-input"
				value={draft}
				aria-label="Cell value"
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => props.onCommit({ kind: "text", text: draft })}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						props.onCommit({ kind: "text", text: draft });
					} else if (event.key === "Escape") {
						event.preventDefault();
						props.onCancel();
					} else if (
						event.key === "Backspace" &&
						(event.ctrlKey || event.metaKey)
					) {
						// Ctrl/Cmd+Backspace is "make this NULL" — an empty string
						// and NULL are different values and need different gestures.
						event.preventDefault();
						props.onCommit({ kind: "null" });
					}
				}}
			/>
		);
	}

	return (
		<button
			type="button"
			className="dg-tv-cellbtn"
			onClick={props.onFocus}
			onFocus={props.onFocus}
			onDoubleClick={() => {
				if (props.editable) {
					props.onStartEdit();
				}
			}}
			onKeyDown={(event) => {
				// Enter / F2 opens the editor, the way a spreadsheet does.
				if (props.editable && (event.key === "Enter" || event.key === "F2")) {
					event.preventDefault();
					props.onStartEdit();
				}
			}}
		>
			{shown.text}
		</button>
	);
}

export function TableView(props: IDockviewPanelProps) {
	const params = readViewPanelParams(props.params);
	const connection = useConnectionsStore((state) =>
		state.connections.find((entry) => entry.id === params.connectionId),
	);
	const role = useSessionStore((state) => state.currentWorkspace?.role);

	const [limit, setLimit] = useState<number>(ROW_LIMITS[0]);
	const [offset, setOffset] = useState(0);
	const [sort, setSort] = useState<TableSort[]>([]);
	const [filterDraft, setFilterDraft] = useState("");
	const [filter, setFilter] = useState("");
	const [data, setData] = useState<TableRowsResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [edits, setEdits] = useState<PendingEdits>(NO_PENDING_EDITS);
	const [focus, setFocus] = useState<Focus | null>(null);
	const [editing, setEditing] = useState<Focus | null>(null);
	const [transposed, setTransposed] = useState(false);
	const [panelOpen, setPanelOpen] = useState(false);
	const [saving, setSaving] = useState(false);

	const capabilities =
		connection === undefined
			? undefined
			: ADAPTER_CAPABILITIES[connection.adapter];

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await wsClient.request<TableRowsResult>("table.rows", {
				connectionId: params.connectionId,
				schema: params.schema,
				table: params.name,
				kind: params.kind,
				limit,
				offset,
				sort,
				filter,
				count: true,
			});
			setData(result);
			// A refetch re-sorts and re-pages, so a pending edit keyed on row
			// index no longer points at the row the user touched.
			setEdits(NO_PENDING_EDITS);
			setEditing(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not read rows");
		} finally {
			setLoading(false);
		}
	}, [
		params.connectionId,
		params.schema,
		params.name,
		params.kind,
		limit,
		offset,
		sort,
		filter,
	]);

	useEffect(() => {
		if (capabilities?.tableData == null) {
			return;
		}
		void load();
	}, [load, capabilities?.tableData]);

	const columns = data?.columns ?? [];
	const rows = data?.rows ?? [];
	const writableColumns = columns.filter((column) => !column.generated);
	const canEdit =
		data?.editable === true && role !== "viewer" && !saving && !loading;
	const dirty = isDirty(edits);

	const commit = async () => {
		const list = buildEdits(edits, columns, rows);
		if (list.length === 0) {
			setEdits(NO_PENDING_EDITS);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await wsClient.request("table.mutate", {
				connectionId: params.connectionId,
				schema: params.schema,
				table: params.name,
				edits: list,
				idempotencyKey: crypto.randomUUID(),
			});
			setEdits(NO_PENDING_EDITS);
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save");
		} finally {
			setSaving(false);
		}
	};

	const setCell = (target: Focus, value: CellInput) => {
		setEdits((current) =>
			target.kind === "insert"
				? withInsertCellEdit(current, target.index, target.column, value)
				: withCellEdit(current, target.index, target.column, value),
		);
		setEditing(null);
	};

	const focusedValue = (): unknown => {
		if (focus === null) {
			return null;
		}
		const columnIndex = columns.findIndex(
			(column) => column.name === focus.column,
		);
		if (columnIndex < 0) {
			return null;
		}
		if (focus.kind === "insert") {
			const input = edits.inserts[focus.index]?.[focus.column];
			return input === undefined || input.kind !== "text" ? null : input.text;
		}
		const pending = pendingCell(edits, focus.index, focus.column);
		if (pending !== undefined) {
			return pending.kind === "text" ? pending.text : null;
		}
		return rows[focus.index]?.[columnIndex] ?? null;
	};

	if (capabilities !== undefined && capabilities.tableData == null) {
		return (
			<div className="dg-tv">
				<div className="dg-tv-body dg-scroll">
					<div className="dg-tree-note">
						{connection?.name ?? "This datasource"} has no table view — its
						objects are not relations.
					</div>
				</div>
			</div>
		);
	}

	/**
	 * One data cell. `cellKey` is explicit because the two orientations
	 * disagree about what makes a cell unique among its siblings: across a
	 * normal row it is the column, across a transposed row it is the row.
	 */
	const cellFor = (
		rowIndex: number,
		column: TableColumn,
		columnIndex: number,
		cellKey: string,
	) => {
		const target: Focus = { kind: "row", index: rowIndex, column: column.name };
		const value = rows[rowIndex]?.[columnIndex] ?? null;
		const pending = pendingCell(edits, rowIndex, column.name);
		const display = cellDisplay(value);
		const isFocused =
			focus?.kind === "row" &&
			focus.index === rowIndex &&
			focus.column === column.name;
		const classes = ["dg-tv-cell"];
		if (column.primaryKey) {
			classes.push("dg-tv-pk");
		} else if (pending === undefined && display.isNull) {
			classes.push("dg-grid-null");
		} else if (pending === undefined && typeof value === "number") {
			classes.push("dg-grid-num");
		}
		if (pending !== undefined) {
			classes.push("dg-tv-dirty");
		}
		if (isFocused) {
			classes.push("dg-tv-focused");
		}
		return (
			<td key={cellKey} className={classes.join(" ")}>
				<CellBody
					value={value}
					pending={pending}
					onFocus={() => setFocus(target)}
					editing={
						editing?.kind === "row" &&
						editing.index === rowIndex &&
						editing.column === column.name
					}
					editable={canEdit && !column.generated}
					onStartEdit={() => setEditing(target)}
					onCommit={(next) => setCell(target, next)}
					onCancel={() => setEditing(null)}
				/>
			</td>
		);
	};

	const insertCellFor = (insertIndex: number, column: TableColumn) => {
		const target: Focus = {
			kind: "insert",
			index: insertIndex,
			column: column.name,
		};
		const pending = edits.inserts[insertIndex]?.[column.name];
		const isFocused =
			focus?.kind === "insert" &&
			focus.index === insertIndex &&
			focus.column === column.name;
		return (
			<td
				key={column.name}
				className={`dg-tv-cell dg-tv-new${isFocused ? " dg-tv-focused" : ""}`}
			>
				<CellBody
					value={null}
					pending={pending}
					onFocus={() => setFocus(target)}
					editing={
						editing?.kind === "insert" &&
						editing.index === insertIndex &&
						editing.column === column.name
					}
					editable={canEdit && !column.generated}
					onStartEdit={() => setEditing(target)}
					onCommit={(next) => setCell(target, next)}
					onCancel={() => setEditing(null)}
				/>
			</td>
		);
	};

	const header = (column: TableColumn) => {
		const direction = sortDirection(sort, column.name);
		const position = sort.findIndex((term) => term.column === column.name);
		return (
			<th key={column.name} className={column.primaryKey ? "dg-tv-pk" : ""}>
				<button
					type="button"
					className="dg-tv-th"
					title={`${column.name} · ${column.dataType}${
						column.nullable ? "" : " · not null"
					}`}
					onClick={(event) => {
						setSort(nextSort(sort, column.name, event.shiftKey));
						setOffset(0);
					}}
				>
					{column.name}
					<span className="dg-tv-sort">
						{direction === "asc" ? "▲" : direction === "desc" ? "▼" : ""}
						{sort.length > 1 && position >= 0 ? position + 1 : ""}
					</span>
				</button>
			</th>
		);
	};

	return (
		<div className="dg-tv">
			<div className="dg-tv-bar">
				<button
					type="button"
					className="dg-tv-ico"
					title="Refresh"
					aria-label="Refresh"
					disabled={loading || saving}
					onClick={() => void load()}
				>
					↻
				</button>
				<input
					className="dg-tv-filter"
					placeholder={role === "viewer" ? "where … (editors only)" : "where …"}
					aria-label="Row filter"
					title={
						role === "viewer"
							? "A predicate is arbitrary SQL, which viewers cannot run"
							: "Filter rows — press Enter to apply, Escape to clear"
					}
					disabled={role === "viewer"}
					value={filterDraft}
					onChange={(event) => setFilterDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							setOffset(0);
							setFilter(filterDraft.trim());
						} else if (event.key === "Escape") {
							setFilterDraft("");
							setOffset(0);
							setFilter("");
						}
					}}
				/>
				<select
					className="dg-tv-limit"
					aria-label="Row limit"
					value={limit}
					onChange={(event) => {
						setOffset(0);
						setLimit(Number(event.target.value));
					}}
				>
					{ROW_LIMITS.map((value) => (
						<option key={value} value={value}>
							{numberFormat(value)} rows
						</option>
					))}
				</select>
				<span className="dg-tv-page">
					<button
						type="button"
						className="dg-tv-ico"
						title="Previous page"
						aria-label="Previous page"
						disabled={offset === 0 || loading}
						onClick={() => setOffset(Math.max(0, offset - limit))}
					>
						‹
					</button>
					<span className="dg-tv-range">
						{rows.length === 0
							? "0"
							: `${numberFormat(offset + 1)}–${numberFormat(
									offset + rows.length,
								)}`}
					</span>
					<button
						type="button"
						className="dg-tv-ico"
						title="Next page"
						aria-label="Next page"
						disabled={rows.length < limit || loading}
						onClick={() => setOffset(offset + limit)}
					>
						›
					</button>
				</span>
				{dirty && (
					<span className="dg-tv-commit">
						<button
							type="button"
							className="dg-tv-apply"
							disabled={saving}
							onClick={() => void commit()}
						>
							commit {pendingCount(edits)}
						</button>
						<button
							type="button"
							className="dg-tv-revert"
							disabled={saving}
							onClick={() => {
								setEdits(NO_PENDING_EDITS);
								setEditing(null);
							}}
						>
							revert
						</button>
					</span>
				)}
				<span className="dg-modal-actions-spacer" />
				<ExportControls
					columns={columns}
					rows={() => rows}
					filename={`${params.schema}.${params.name}`}
				/>
				<OverflowMenu
					transposed={transposed}
					panelOpen={panelOpen}
					canEdit={canEdit}
					deleteEnabled={focus?.kind === "row"}
					onToggleTranspose={() => setTransposed((value) => !value)}
					onTogglePanel={() => setPanelOpen((value) => !value)}
					onInsertRow={() =>
						setEdits((current) => withNewRow(current, writableColumns))
					}
					onDeleteRow={() => {
						if (focus?.kind === "row") {
							setEdits((current) => withDeleteToggled(current, focus.index));
						}
					}}
				/>
			</div>

			<div className="dg-tv-main">
				<div className="dg-tv-body dg-scroll">
					{error !== null && <div className="dg-results-error">{error}</div>}
					{data === null && error === null && (
						<div className="dg-tree-note dg-tree-note-loading">loading…</div>
					)}
					{data !== null && columns.length > 0 && !transposed && (
						<table className="dg-grid dg-tv-grid">
							<thead>
								<tr>
									<th className="dg-grid-rn" aria-label="Row number" />
									{columns.map(header)}
								</tr>
							</thead>
							<tbody>
								{rows.map((_row, rowIndex) => (
									<tr
										// biome-ignore lint/suspicious/noArrayIndexKey: a page row's identity is its position in the page
										key={rowIndex}
										className={
											edits.deletes.includes(rowIndex) ? "dg-tv-deleted" : ""
										}
									>
										<td className="dg-grid-rn">{offset + rowIndex + 1}</td>
										{columns.map((column, columnIndex) =>
											cellFor(rowIndex, column, columnIndex, column.name),
										)}
									</tr>
								))}
								{edits.inserts.map((_insert, insertIndex) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: draft rows are identified by insertion order
									<tr key={`new-${insertIndex}`} className="dg-tv-newrow">
										<td className="dg-grid-rn">
											<button
												type="button"
												className="dg-tv-ico"
												title="Discard this draft row"
												aria-label="Discard draft row"
												onClick={() =>
													setEdits((current) =>
														withoutInsert(current, insertIndex),
													)
												}
											>
												×
											</button>
										</td>
										{columns.map((column) =>
											insertCellFor(insertIndex, column),
										)}
									</tr>
								))}
							</tbody>
						</table>
					)}
					{data !== null && columns.length > 0 && transposed && (
						<table className="dg-grid dg-tv-grid">
							<thead>
								<tr>
									<th>column</th>
									{rows.map((_row, rowIndex) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: a page row's identity is its position in the page
										<th key={rowIndex} className="dg-grid-rn">
											{offset + rowIndex + 1}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{columns.map((column, columnIndex) => (
									<tr key={column.name}>
										<th
											className={
												column.primaryKey
													? "dg-tv-rowhead dg-tv-pk"
													: "dg-tv-rowhead"
											}
											title={column.dataType}
										>
											{column.name}
										</th>
										{rows.map((_row, rowIndex) =>
											cellFor(rowIndex, column, columnIndex, `row-${rowIndex}`),
										)}
									</tr>
								))}
							</tbody>
						</table>
					)}
					{data !== null && rows.length === 0 && edits.inserts.length === 0 && (
						<div className="dg-tree-note">
							{filter === "" ? "The table is empty." : "No rows match."}
						</div>
					)}
				</div>

				{panelOpen && (
					<aside className="dg-tv-side">
						<div className="dg-tv-side-head">
							<span>{focus?.column ?? "no cell selected"}</span>
							<button
								type="button"
								className="dg-tv-ico"
								aria-label="Close value panel"
								title="Close"
								onClick={() => setPanelOpen(false)}
							>
								×
							</button>
						</div>
						<pre className="dg-tv-side-body dg-scroll">
							{focus === null ? "Click a cell." : cellDetail(focusedValue())}
						</pre>
						<div className="dg-tv-side-foot">
							<button
								type="button"
								disabled={focus === null}
								onClick={() => {
									void navigator.clipboard.writeText(
										cellDetail(focusedValue()),
									);
								}}
							>
								copy
							</button>
							<button
								type="button"
								disabled={!canEdit || focus === null}
								onClick={() => {
									if (focus !== null) {
										setCell(focus, { kind: "null" });
									}
								}}
							>
								set null
							</button>
						</div>
					</aside>
				)}
			</div>

			<div className="dg-tv-foot">
				<span>{data === null ? "…" : rowCountLabel(data, rows.length)}</span>
				<span className="dg-tv-foot-state">
					{saving
						? "saving…"
						: dirty
							? `${pendingCount(edits)} pending — commit or revert`
							: data?.editable === true && role !== "viewer"
								? "read only until you edit a cell"
								: (data?.reason ?? "read only")}
				</span>
			</div>
		</div>
	);
}
