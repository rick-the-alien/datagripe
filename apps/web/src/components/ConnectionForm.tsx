import type {
	ConnectionAdapter,
	ConnectionMetadata,
	ConnectionTestResult,
} from "@datagripe/contracts";
import { ADAPTER_CAPABILITIES } from "@datagripe/contracts";
import type { IDockviewPanelProps } from "dockview-react";
import { useState } from "react";
import { readConnectionFormParams } from "../app/viewPanels";
import {
	ENGINE_CHIPS,
	NAMESPACE_LABELS,
	useDatasourceStore,
} from "../stores/datasource";
import { type ConnectionDraft, useConnectionsStore } from "../stores/runtime";

/**
 * Datasource create/edit form as a dock tab, not a modal
 * (docs/brand/mocks/datasource-selector.html "New datasource is a tab").
 * Fields are driven entirely by the adapter's capability descriptor
 * (ADAPTER_CAPABILITIES) — the form never branches on adapter ids
 * (roadmap Phase 5 exit criterion). Draft, test and save state are local
 * so two forms can sit side by side without clobbering each other.
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
	showAllSchemas: false,
};

const ADAPTERS: ConnectionAdapter[] = ["postgres", "mysql", "sqlite", "redis"];

/** Display names per the mock; the tree and status line use short ids. */
const ADAPTER_NAMES: Record<ConnectionAdapter, string> = {
	postgres: "PostgreSQL",
	mysql: "MySQL",
	sqlite: "SQLite",
	redis: "Redis",
};

/** Plural of NAMESPACE_LABELS for the tree-setting checkbox label. */
const NAMESPACE_PLURALS: Record<ConnectionAdapter, string> = {
	postgres: "schemas",
	mysql: "databases",
	sqlite: "files",
	redis: "keyspaces",
};

export function ConnectionForm(props: IDockviewPanelProps) {
	const { connectionId } = readConnectionFormParams(props.params);
	const connections = useConnectionsStore((state) => state.connections);
	const loaded = useConnectionsStore((state) => state.loaded);
	const workspaceName = useConnectionsStore((state) => state.workspaceName);
	const connection =
		connectionId === undefined
			? null
			: (connections.find((entry) => entry.id === connectionId) ?? null);

	if (connectionId !== undefined && connection === null) {
		return (
			<div className="dg-form dg-scroll">
				<div className="dg-form-body">
					<h3 className="dg-form-title">Datasource</h3>
					<p className="dg-form-lead">
						{loaded
							? "This datasource no longer exists."
							: "Loading datasources…"}
					</p>
				</div>
			</div>
		);
	}

	return (
		<ConnectionFormBody
			key={connection?.id ?? "new"}
			panel={props}
			connection={connection}
			workspaceName={workspaceName}
		/>
	);
}

function ConnectionFormBody(props: {
	panel: IDockviewPanelProps;
	connection: ConnectionMetadata | null;
	workspaceName: string | null;
}) {
	const editing = props.connection;
	const readOnly = editing?.source === "predefined";
	const editingId = editing?.source === "managed" ? editing.id : null;

	const [draft, setDraft] = useState<ConnectionDraft>(() => {
		if (editing === null) {
			return EMPTY_DRAFT;
		}
		const capabilities = ADAPTER_CAPABILITIES[editing.adapter];
		return {
			adapter: editing.adapter,
			name: editing.name,
			host: editing.host ?? "",
			port: editing.port ?? capabilities.defaultPort ?? 5432,
			databaseName: editing.databaseName,
			username: editing.username ?? "",
			password: "",
			tlsMode: editing.tlsMode ?? "disable",
			readOnly: editing.readOnly,
			showAllSchemas: editing.showAllSchemas,
		};
	});
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<ConnectionTestResult | null>(
		null,
	);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

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

	const test = async () => {
		setTesting(true);
		setTestResult(null);
		try {
			setTestResult(
				await useConnectionsStore.getState().testDraft(draft, editingId),
			);
		} finally {
			setTesting(false);
		}
	};

	const save = async () => {
		setSaving(true);
		setSaveError(null);
		try {
			const id = await useConnectionsStore
				.getState()
				.saveDraft(draft, editingId);
			// "Save and connect": a freshly created datasource becomes the
			// active one — selecting a datasource is what connects it.
			if (editingId === null && id !== null) {
				useDatasourceStore.getState().setActive(id);
			}
			props.panel.api.close();
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : "Save failed");
		} finally {
			setSaving(false);
		}
	};

	const testline = testing
		? "testing…"
		: testResult === null
			? "not tested"
			: testResult.ok
				? `connected${
						testResult.latencyMs !== undefined
							? ` · ${testResult.latencyMs}ms`
							: ""
					}${
						testResult.serverVersion !== undefined
							? ` · ${testResult.serverVersion.split(",")[0]}`
							: ""
					}`
				: (testResult.error?.message ?? "connection failed");
	const testlineClass =
		testResult === null || testing
			? "dg-testline"
			: testResult.ok
				? "dg-testline is-ok"
				: "dg-testline is-err";

	return (
		<div className="dg-form dg-scroll">
			<div className="dg-form-body">
				<h3 className="dg-form-title">
					{editing === null ? "New datasource" : `Edit ${editing.name}`}
				</h3>
				<p className="dg-form-lead">
					{editing === null ? (
						<>
							Added to <b>{props.workspaceName ?? "this project"}</b>.
							Credentials are stored in the project, not globally.
						</>
					) : readOnly ? (
						"Defined by server configuration — read-only."
					) : (
						<>
							Stored in <b>{props.workspaceName ?? "this project"}</b>. Leave
							the password blank to keep the current one.
						</>
					)}
				</p>

				<fieldset className="dg-eng" aria-label="Engine">
					{ADAPTERS.map((adapter) => (
						<button
							key={adapter}
							type="button"
							aria-pressed={draft.adapter === adapter}
							disabled={readOnly || editing !== null}
							onClick={() => switchAdapter(adapter)}
						>
							<span className="dg-crumb-chip">{ENGINE_CHIPS[adapter]}</span>
							{ADAPTER_NAMES[adapter]}
						</button>
					))}
				</fieldset>

				<div className="dg-fgrid">
					<label className="dg-field">
						<span>Name</span>
						<input
							value={draft.name}
							disabled={readOnly}
							ref={(input) => {
								if (!readOnly && editing === null) {
									input?.focus();
								}
							}}
							onChange={(event) => patch({ name: event.target.value })}
						/>
					</label>
					{has("host") && (
						<label className="dg-field">
							<span>Host</span>
							<input
								value={draft.host}
								disabled={readOnly}
								onChange={(event) => patch({ host: event.target.value })}
							/>
						</label>
					)}
					{has("port") && (
						<label className="dg-field">
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

				<div className="dg-fgrid">
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
				</div>

				<div className="dg-fgrid">
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

				{/* SQLite has exactly one namespace — the tree setting would
				    be a no-op, so it stays hidden there. */}
				{draft.adapter !== "sqlite" && (
					<div className="dg-field">
						<label className="dg-field dg-field-checkbox">
							<input
								type="checkbox"
								checked={draft.showAllSchemas}
								disabled={readOnly}
								onChange={(event) =>
									patch({ showAllSchemas: event.target.checked })
								}
							/>
							<span>
								Show all {NAMESPACE_PLURALS[draft.adapter]} in the tree
							</span>
						</label>
						<p className="dg-form-note">
							The tree gains a {NAMESPACE_LABELS[draft.adapter]} level you can
							expand several of at once — for cross-
							{NAMESPACE_LABELS[draft.adapter]} joins. Off: the tree scopes to
							the {NAMESPACE_LABELS[draft.adapter]} picked in the breadcrumb.
						</p>
					</div>
				)}

				{saveError !== null && <p className="dg-test-failed">{saveError}</p>}

				<div className="dg-frow">
					<button
						type="button"
						className="dg-btn"
						disabled={testing || readOnly}
						onClick={() => void test()}
					>
						{testing ? "testing…" : "test connection"}
					</button>
					<button
						type="button"
						className="dg-btn dg-btn-pri"
						disabled={!canSave || saving}
						onClick={() => void save()}
					>
						{saving
							? "saving…"
							: editing === null
								? "save and connect"
								: "save"}
					</button>
					<span className={testlineClass}>{testline}</span>
				</div>
			</div>
		</div>
	);
}
