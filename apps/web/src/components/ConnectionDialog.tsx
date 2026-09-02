import type { ConnectionAdapter } from "@datagripe/contracts";
import { ADAPTER_CAPABILITIES } from "@datagripe/contracts";
import { useEffect, useState } from "react";
import { type ConnectionDraft, useConnectionsStore } from "../stores/runtime";

/**
 * DataGrip-style connection dialog. Fields are driven entirely by the
 * adapter's capability descriptor (ADAPTER_CAPABILITIES) — the dialog
 * never branches on adapter ids (roadmap Phase 5 exit criterion).
 */

const EMPTY_DRAFT: ConnectionDraft = {
	adapter: "postgres",
	name: "",
	host: "localhost",
	port: ADAPTER_CAPABILITIES.postgres.defaultPort ?? 5432,
	databaseName: "",
	username: "",
	password: "",
	tlsMode: "disable",
	readOnly: true,
};

const ADAPTERS: ConnectionAdapter[] = ["postgres", "mysql", "sqlite", "redis"];

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
			const capabilities = ADAPTER_CAPABILITIES[dialog.connection.adapter];
			setDraft({
				adapter: dialog.connection.adapter,
				name: dialog.connection.name,
				host: dialog.connection.host ?? "",
				port: dialog.connection.port ?? capabilities.defaultPort ?? 5432,
				databaseName: dialog.connection.databaseName,
				username: dialog.connection.username ?? "",
				password: "",
				tlsMode: dialog.connection.tlsMode ?? "disable",
				readOnly: dialog.connection.readOnly,
			});
		}
	}, [dialog]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				store.closeDialog();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [store]);

	if (dialog.mode === "closed") {
		return null;
	}

	const capabilities = ADAPTER_CAPABILITIES[draft.adapter];
	const has = (field: string) => capabilities.fields.includes(field as never);

	const patch = (partial: Partial<ConnectionDraft>) =>
		setDraft((current) => ({ ...current, ...partial }));

	const switchAdapter = (adapter: ConnectionAdapter) => {
		const next = ADAPTER_CAPABILITIES[adapter];
		setDraft((current) => ({
			...current,
			adapter,
			port: next.defaultPort ?? current.port,
		}));
	};

	const editingId = editing?.source === "managed" ? editing.id : null;
	const needsUsername = draft.adapter !== "redis" && has("username");
	const canSave =
		!readOnly &&
		draft.name.trim().length > 0 &&
		draft.databaseName.trim().length > 0 &&
		(!has("host") || draft.host.trim().length > 0) &&
		(!needsUsername || draft.username.trim().length > 0) &&
		(editing !== null ||
			draft.adapter === "sqlite" ||
			draft.adapter === "redis" ||
			draft.password.length > 0);

	return (
		<div className="dg-modal-backdrop" role="presentation">
			<div
				className="dg-modal dg-scroll"
				role="dialog"
				aria-label="Connection settings"
			>
				<div className="dg-modal-title">
					{editing === null ? "New connection" : `Edit ${editing.name}`}
				</div>

				{readOnly && (
					<p className="dg-modal-hint">
						Defined by server configuration — read-only.
					</p>
				)}

				<div className="dg-field-row">
					<label className="dg-field">
						<span>Type</span>
						<select
							value={draft.adapter}
							disabled={readOnly || editing !== null}
							onChange={(event) =>
								switchAdapter(event.target.value as ConnectionAdapter)
							}
						>
							{ADAPTERS.map((adapter) => (
								<option key={adapter} value={adapter}>
									{adapter}
								</option>
							))}
						</select>
					</label>
					<label className="dg-field">
						<span>Name</span>
						<input
							value={draft.name}
							disabled={readOnly}
							ref={(input) => {
								if (!readOnly) {
									input?.focus();
								}
							}}
							onChange={(event) => patch({ name: event.target.value })}
						/>
					</label>
				</div>
				{has("host") && (
					<div className="dg-field-row">
						<label className="dg-field">
							<span>Host</span>
							<input
								value={draft.host}
								disabled={readOnly}
								onChange={(event) => patch({ host: event.target.value })}
							/>
						</label>
						{has("port") && (
							<label className="dg-field dg-field-port">
								<span>Port</span>
								<input
									type="number"
									min={1}
									max={65535}
									value={draft.port}
									disabled={readOnly}
									onChange={(event) =>
										patch({ port: Number(event.target.value) || 1 })
									}
								/>
							</label>
						)}
					</div>
				)}
				<label className="dg-field">
					<span>{capabilities.databaseLabel}</span>
					<input
						value={draft.databaseName}
						disabled={readOnly}
						placeholder={
							draft.adapter === "sqlite"
								? "/var/lib/datagripe/demo.db"
								: undefined
						}
						onChange={(event) => patch({ databaseName: event.target.value })}
					/>
				</label>
				{has("username") && (
					<label className="dg-field">
						<span>
							Username{draft.adapter === "redis" ? " (optional)" : ""}
						</span>
						<input
							value={draft.username}
							disabled={readOnly}
							onChange={(event) => patch({ username: event.target.value })}
						/>
					</label>
				)}
				{has("password") && (
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
				)}
				<div className="dg-field-row">
					{has("tlsMode") && (
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
					)}
					{has("readOnly") && (
						<label className="dg-field dg-field-checkbox">
							<input
								type="checkbox"
								checked={draft.readOnly}
								disabled={readOnly}
								onChange={(event) => patch({ readOnly: event.target.checked })}
							/>
							<span>Read-only</span>
						</label>
					)}
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
