import { useEffect, useState } from "react";
import { type ConnectionDraft, useConnectionsStore } from "../stores/runtime";

/**
 * DataGrip-style connection dialog: named, testable connection form.
 * Predefined connections render read-only with a hint (they are defined
 * by server configuration). Passwords are write-only: empty while
 * editing keeps the stored secret.
 */

const EMPTY_DRAFT: ConnectionDraft = {
	name: "",
	host: "localhost",
	port: 5432,
	databaseName: "",
	username: "",
	password: "",
	tlsMode: "disable",
	readOnly: true,
};

export function ConnectionDialog() {
	const dialog = useConnectionsStore((state) => state.dialog);
	const saving = useConnectionsStore((state) => state.saving);
	const testing = useConnectionsStore((state) => state.testing);
	const testResult = useConnectionsStore((state) => state.testResult);
	const store = useConnectionsStore.getState();

	const editing = dialog.mode === "edit" ? dialog.connection : null;
	const readOnly = editing?.source === "predefined";

	const [draft, setDraft] = useState<ConnectionDraft>(EMPTY_DRAFT);

	useEffect(() => {
		if (dialog.mode === "create") {
			setDraft(EMPTY_DRAFT);
		} else if (dialog.mode === "edit") {
			setDraft({
				name: dialog.connection.name,
				host: dialog.connection.host,
				port: dialog.connection.port,
				databaseName: dialog.connection.databaseName,
				username: dialog.connection.username,
				password: "",
				tlsMode: dialog.connection.tlsMode,
				readOnly: dialog.connection.readOnly,
			});
		}
	}, [dialog]);

	if (dialog.mode === "closed") {
		return null;
	}

	const patch = (partial: Partial<ConnectionDraft>) =>
		setDraft((current) => ({ ...current, ...partial }));

	const editingId = editing?.source === "managed" ? editing.id : null;
	const canSave =
		!readOnly &&
		draft.name.trim().length > 0 &&
		draft.host.trim().length > 0 &&
		draft.databaseName.trim().length > 0 &&
		draft.username.trim().length > 0 &&
		(editing !== null || draft.password.length > 0);

	return (
		<div className="dg-modal-backdrop" role="presentation">
			<div className="dg-modal" role="dialog" aria-label="Connection settings">
				<div className="dg-modal-title">
					{editing === null ? "New connection" : `Edit ${editing.name}`}
				</div>

				{readOnly && (
					<p className="dg-modal-hint">
						Defined by server configuration — read-only.
					</p>
				)}

				<label className="dg-field">
					<span>Name</span>
					<input
						value={draft.name}
						disabled={readOnly}
						onChange={(event) => patch({ name: event.target.value })}
					/>
				</label>
				<div className="dg-field-row">
					<label className="dg-field">
						<span>Host</span>
						<input
							value={draft.host}
							disabled={readOnly}
							onChange={(event) => patch({ host: event.target.value })}
						/>
					</label>
					<label className="dg-field dg-field-port">
						<span>Port</span>
						<input
							type="number"
							min={1}
							max={65535}
							value={draft.port}
							disabled={readOnly}
							onChange={(event) =>
								patch({ port: Number(event.target.value) || 5432 })
							}
						/>
					</label>
				</div>
				<label className="dg-field">
					<span>Database</span>
					<input
						value={draft.databaseName}
						disabled={readOnly}
						onChange={(event) => patch({ databaseName: event.target.value })}
					/>
				</label>
				<label className="dg-field">
					<span>Username</span>
					<input
						value={draft.username}
						disabled={readOnly}
						onChange={(event) => patch({ username: event.target.value })}
					/>
				</label>
				<label className="dg-field">
					<span>Password</span>
					<input
						type="password"
						value={draft.password}
						disabled={readOnly}
						placeholder={
							editing !== null && !readOnly
								? "Leave blank to keep current"
								: undefined
						}
						onChange={(event) => patch({ password: event.target.value })}
					/>
				</label>
				<div className="dg-field-row">
					<label className="dg-field">
						<span>TLS</span>
						<select
							value={draft.tlsMode}
							disabled={readOnly}
							onChange={(event) =>
								patch({
									tlsMode: event.target.value as ConnectionDraft["tlsMode"],
								})
							}
						>
							<option value="disable">disable</option>
							<option value="require">require</option>
							<option value="verify-full">verify-full</option>
						</select>
					</label>
					<label className="dg-field dg-field-checkbox">
						<input
							type="checkbox"
							checked={draft.readOnly}
							disabled={readOnly}
							onChange={(event) => patch({ readOnly: event.target.checked })}
						/>
						<span>Read-only</span>
					</label>
				</div>

				{testResult !== null && (
					<p className={testResult.ok ? "dg-test-ok" : "dg-test-failed"}>
						{testResult.ok
							? `Connected${
									testResult.latencyMs !== undefined
										? ` in ${testResult.latencyMs} ms`
										: ""
								}${
									testResult.serverVersion !== undefined
										? ` — ${testResult.serverVersion.split(",")[0]}`
										: ""
								}`
							: (testResult.error?.message ?? "Connection failed")}
					</p>
				)}

				<div className="dg-modal-actions">
					<button
						type="button"
						disabled={testing || readOnly}
						onClick={() => void store.testDraft(draft, editingId)}
					>
						{testing ? "Testing…" : "Test connection"}
					</button>
					<span className="dg-modal-actions-spacer" />
					<button type="button" onClick={() => store.closeDialog()}>
						Cancel
					</button>
					<button
						type="button"
						disabled={!canSave || saving}
						onClick={() => void store.saveDraft(draft, editingId)}
					>
						{saving ? "Saving…" : "Save"}
					</button>
				</div>
			</div>
		</div>
	);
}
