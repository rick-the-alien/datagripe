import type {
	ColumnChangeKind,
	ObjectAlterResult,
	ObjectDescribeResult,
} from "@datagripe/contracts";
import { useState } from "react";
import { wsClient } from "../api/ws";
import {
	buildColumnChanges,
	type ColumnPatch,
	type DraftColumn,
	draftProblem,
	isColumnsDirty,
	NO_PENDING_COLUMNS,
	type PendingColumns,
	patchedValue,
	pendingColumnCount,
	requiredChangeKinds,
	withDraft,
	withDraftPatch,
	withDropToggled,
	withoutDraft,
	withPatch,
} from "./columnEdits";

/**
 * The columns tab (docs/spec/object-view.md "Editing columns"). Edits
 * gather into a pending set; `review` asks the server for the exact SQL
 * and shows it; `apply` runs that same batch.
 *
 * The preview is the gating for structural change. A typed confirmation
 * on every field would be noise, but reading the statement before it
 * runs is not — and because the preview and the apply are one action
 * with a `dryRun` flag, the SQL shown cannot drift from the SQL that
 * executes. Dropping a column is the exception and still types the name.
 */

const KIND_LABELS: Record<ColumnChangeKind, string> = {
	add: "add a column",
	rename: "rename a column",
	setType: "change a type",
	setNullable: "change nullability",
	setDefault: "change a default",
	setComment: "change a comment",
	drop: "drop a column",
};

function TextCell(props: {
	value: string;
	placeholder?: string | undefined;
	dirty: boolean;
	disabled: boolean;
	title?: string | undefined;
	onChange: (value: string) => void;
}) {
	return (
		<input
			className={props.dirty ? "dg-col-input dg-col-dirty" : "dg-col-input"}
			value={props.value}
			placeholder={props.placeholder}
			disabled={props.disabled}
			title={props.title}
			onChange={(event) => props.onChange(event.target.value)}
		/>
	);
}

export function ColumnsTab(props: {
	data: ObjectDescribeResult;
	/** Column changes this engine can make at all. */
	supported: ColumnChangeKind[];
	canEdit: boolean;
	/** Why editing is off, when it is. */
	readOnlyReason: string | null;
	connectionId: string;
	onApplied: () => void;
}) {
	const { data, supported } = props;
	const [pending, setPending] = useState<PendingColumns>(NO_PENDING_COLUMNS);
	const [preview, setPreview] = useState<string[] | null>(null);
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const changes = buildColumnChanges(pending, data.columns);
	const needed = requiredChangeKinds(changes);
	const unavailable = needed.filter((kind) => !supported.includes(kind));
	const dirty = isColumnsDirty(pending);
	const dropping = pending.drops.length > 0;
	// Dropping a column destroys data, so it is gated like the danger
	// zone: the object's name, typed.
	const armed = !dropping || confirmation === data.name;

	const reset = () => {
		setPending(NO_PENDING_COLUMNS);
		setPreview(null);
		setConfirmation("");
		setError(null);
	};

	const send = async (dryRun: boolean) => {
		setBusy(true);
		setError(null);
		try {
			const result = await wsClient.request<ObjectAlterResult>("object.alter", {
				connectionId: props.connectionId,
				schema: data.schema,
				name: data.name,
				changes,
				dryRun,
				idempotencyKey: crypto.randomUUID(),
			});
			if (dryRun) {
				setPreview(result.statements);
			} else {
				reset();
				props.onApplied();
			}
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "The change was refused",
			);
		} finally {
			setBusy(false);
		}
	};

	const editable = props.canEdit && !busy;

	const draftRow = (draft: DraftColumn, index: number) => {
		const problem = draftProblem(draft);
		return (
			<tr key={`draft-${index}`} className="dg-col-draft">
				<td>
					<button
						type="button"
						className="dg-tv-ico"
						title="Discard this new column"
						aria-label="Discard new column"
						onClick={() => setPending(withoutDraft(pending, index))}
					>
						×
					</button>
				</td>
				<td>
					<TextCell
						value={draft.name}
						placeholder="name"
						dirty
						disabled={!editable}
						onChange={(value) =>
							setPending(withDraftPatch(pending, index, { name: value }))
						}
					/>
				</td>
				<td>
					<TextCell
						value={draft.dataType}
						placeholder="type"
						dirty
						disabled={!editable}
						title={problem ?? undefined}
						onChange={(value) =>
							setPending(withDraftPatch(pending, index, { dataType: value }))
						}
					/>
				</td>
				<td>
					<button
						type="button"
						className="dg-col-null"
						disabled={!editable}
						onClick={() =>
							setPending(
								withDraftPatch(pending, index, { nullable: !draft.nullable }),
							)
						}
					>
						{draft.nullable ? "null" : "not null"}
					</button>
				</td>
				<td>
					<TextCell
						value={draft.defaultExpr ?? ""}
						placeholder="—"
						dirty={draft.defaultExpr !== null}
						disabled={!editable}
						onChange={(value) =>
							setPending(
								withDraftPatch(pending, index, {
									defaultExpr: value === "" ? null : value,
								}),
							)
						}
					/>
				</td>
				<td>
					<TextCell
						value={draft.comment ?? ""}
						placeholder="—"
						dirty={draft.comment !== null}
						disabled={!editable}
						onChange={(value) =>
							setPending(
								withDraftPatch(pending, index, {
									comment: value === "" ? null : value,
								}),
							)
						}
					/>
				</td>
			</tr>
		);
	};

	return (
		<div className="dg-col">
			<div className="dg-col-bar">
				<button
					type="button"
					className="dg-col-add"
					disabled={!editable || !supported.includes("add")}
					title={
						supported.includes("add")
							? "Add a column"
							: "This engine cannot add columns"
					}
					onClick={() => setPending(withDraft(pending))}
				>
					＋ column
				</button>
				{dirty && (
					<>
						<button
							type="button"
							className="dg-col-review"
							disabled={busy || changes.length === 0}
							onClick={() => void send(true)}
						>
							review {pendingColumnCount(pending)}
						</button>
						<button
							type="button"
							className="dg-tv-revert"
							disabled={busy}
							onClick={reset}
						>
							revert
						</button>
					</>
				)}
				<span className="dg-modal-actions-spacer" />
				{props.readOnlyReason !== null && (
					<span className="dg-col-note">{props.readOnlyReason}</span>
				)}
				{unavailable.length > 0 && (
					<span className="dg-col-note dg-ov-pk">
						{unavailable.map((kind) => KIND_LABELS[kind]).join(", ")}: not
						available on this engine
					</span>
				)}
			</div>

			{error !== null && <div className="dg-results-error">{error}</div>}

			<table className="dg-grid dg-ov-grid dg-col-grid">
				<thead>
					<tr>
						<th aria-label="Row actions" />
						<th>name</th>
						<th>type</th>
						<th>null</th>
						<th>default</th>
						<th>comment</th>
					</tr>
				</thead>
				<tbody>
					{data.columns.map((column) => {
						const marked = pending.drops.includes(column.name);
						const patch = pending.patches[column.name];
						const touched = (field: keyof ColumnPatch) =>
							patch !== undefined && field in patch;
						return (
							<tr
								key={column.name}
								className={marked ? "dg-tv-deleted" : undefined}
							>
								<td>
									<button
										type="button"
										className="dg-tv-ico"
										disabled={!editable || !supported.includes("drop")}
										title={
											supported.includes("drop")
												? marked
													? "Keep this column"
													: "Drop this column"
												: "This engine cannot drop columns"
										}
										aria-label={
											marked
												? `Keep column ${column.name}`
												: `Drop column ${column.name}`
										}
										onClick={() =>
											setPending(withDropToggled(pending, column.name))
										}
									>
										{marked ? "↺" : "␡"}
									</button>
								</td>
								<td className={column.primaryKey ? "dg-ov-pk" : undefined}>
									<TextCell
										value={patchedValue(pending, column, "name")}
										dirty={touched("name")}
										disabled={!editable || !supported.includes("rename")}
										title={
											supported.includes("rename")
												? undefined
												: "This engine cannot rename columns"
										}
										onChange={(value) =>
											setPending(
												withPatch(pending, column.name, { name: value }),
											)
										}
									/>
								</td>
								<td>
									<TextCell
										value={patchedValue(pending, column, "dataType")}
										dirty={touched("dataType")}
										disabled={!editable || !supported.includes("setType")}
										title={
											supported.includes("setType")
												? undefined
												: "This engine cannot change a column's type"
										}
										onChange={(value) =>
											setPending(
												withPatch(pending, column.name, { dataType: value }),
											)
										}
									/>
								</td>
								<td>
									<button
										type="button"
										className={
											touched("nullable")
												? "dg-col-null dg-col-dirty"
												: "dg-col-null"
										}
										disabled={!editable || !supported.includes("setNullable")}
										onClick={() =>
											setPending(
												withPatch(pending, column.name, {
													nullable: !patchedValue(pending, column, "nullable"),
												}),
											)
										}
									>
										{patchedValue(pending, column, "nullable")
											? "null"
											: "not null"}
									</button>
								</td>
								<td>
									<TextCell
										value={patchedValue(pending, column, "defaultExpr") ?? ""}
										placeholder="—"
										dirty={touched("defaultExpr")}
										disabled={!editable || !supported.includes("setDefault")}
										onChange={(value) =>
											setPending(
												withPatch(pending, column.name, {
													defaultExpr: value === "" ? null : value,
												}),
											)
										}
									/>
								</td>
								<td>
									<TextCell
										value={patchedValue(pending, column, "comment") ?? ""}
										placeholder="—"
										dirty={touched("comment")}
										disabled={!editable || !supported.includes("setComment")}
										onChange={(value) =>
											setPending(
												withPatch(pending, column.name, {
													comment: value === "" ? null : value,
												}),
											)
										}
									/>
								</td>
							</tr>
						);
					})}
					{pending.drafts.map(draftRow)}
				</tbody>
			</table>

			{preview !== null && (
				<div className="dg-col-preview">
					<div className="dg-col-preview-head">
						This is exactly what will run
						{dropping && " — and it destroys data"}.
					</div>
					<pre className="dg-ov-ddl">{preview.join("\n")}</pre>
					{dropping && (
						<label className="dg-col-confirm">
							Type <code>{data.name}</code> to confirm the drop
							<input
								value={confirmation}
								placeholder={data.name}
								onChange={(event) => setConfirmation(event.target.value)}
							/>
						</label>
					)}
					<div className="dg-col-preview-foot">
						<button
							type="button"
							className={dropping ? "dg-danger-execute" : "dg-tv-apply"}
							disabled={busy || !armed}
							onClick={() => void send(false)}
						>
							{busy ? "applying…" : "apply"}
						</button>
						<button
							type="button"
							className="dg-tv-revert"
							disabled={busy}
							onClick={() => setPreview(null)}
						>
							back
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
