import type {
	ConnectionAdapter,
	ConnectionMetadata,
	ConnectionTestResult,
	DatasourcePath,
	DomainExportPathCheck,
	GitDatasource,
	HostPathCheck,
	IgnoredParam,
	TlsMode,
} from "@datagripe/contracts";
import {
	ADAPTER_CAPABILITIES,
	formatConnectionString,
	parseConnectionString,
	RUNTIME_PARAMS,
	tlsModeSchema,
} from "@datagripe/contracts";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useState } from "react";
import { wsClient } from "../api/ws";
import {
	closeImportDatasource,
	openConnectionForm,
	openDomainManager,
	openSyncPanel,
	readConnectionFormParams,
} from "../app/viewPanels";
import {
	ENGINE_CHIPS,
	NAMESPACE_LABELS,
	useDatasourceStore,
} from "../stores/datasource";
import { type ConnectionDraft, useConnectionsStore } from "../stores/runtime";
import { applyParsed } from "./connectionPaste";
import { ExportConfigPanel } from "./ExportConfigPanel";
import { GitDatasourceRepo } from "./GitDatasourceRepo";
import { ImportDatasource } from "./ImportDatasource";
import { RailFact, RailHelp, RailSection, TabShell } from "./TabRail";
import { Toggle } from "./Toggle";

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
	params: {},
	readOnly: true,
	showAllSchemas: false,
};

const ADAPTERS: ConnectionAdapter[] = ["postgres", "mysql", "sqlite", "redis"];

/**
 * libpq's `sslmode` values in ascending strictness, so the select reads as
 * a scale rather than a set. Taken from the schema so adding one there
 * cannot leave this list behind.
 */
const TLS_MODES: readonly TlsMode[] = tlsModeSchema.options;

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

/**
 * A path pair while the form has it. `key` is a render identity: a row
 * added here has no server id yet, and two blank rows must still be two
 * rows.
 */
interface PathRow {
	key: string;
	id?: string;
	name: string;
	path: string;
}

function toRow(path: DatasourcePath): PathRow {
	return { key: path.id, id: path.id, name: path.name, path: path.path };
}

/** Order-sensitive: the list order is the sidebar's section order. */
function pathsSignature(rows: PathRow[]): string {
	return JSON.stringify(
		rows.map((row) => [row.id ?? "", row.name.trim(), row.path.trim()]),
	);
}

export function ConnectionForm(props: IDockviewPanelProps) {
	const { connectionId, mode } = readConnectionFormParams(props.params);
	const connections = useConnectionsStore((state) => state.connections);
	const loaded = useConnectionsStore((state) => state.loaded);
	const workspaceName = useConnectionsStore((state) => state.workspaceName);
	const connection =
		connectionId === undefined
			? null
			: (connections.find((entry) => entry.id === connectionId) ?? null);

	if (mode === "import" && connectionId === undefined) {
		return (
			<div className="dg-form dg-scroll">
				<div className="dg-form-body">
					<h3 className="dg-form-title">Import datasource</h3>
					<p className="dg-form-lead">
						From a git repository that carries a <code>.datagripe/</code>{" "}
						directory. Added to <b>{workspaceName ?? "this project"}</b>.
					</p>
					<ImportDatasource
						onImported={(created) => {
							// Straight onto its own page: the repository defined the
							// connection, but the password, `read only` and `show all
							// schemas` are this project's to set, and testing it is
							// the obvious next thing to do.
							openConnectionForm(created);
							closeImportDatasource();
						}}
					/>
				</div>
			</div>
		);
	}

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
	/**
	 * A git datasource is read-only here for the same reason a predefined
	 * one is, with a different fix: you change it by editing
	 * `.datagripe/config.yaml` in the repository, which is the whole point
	 * of it being there (docs/spec/git-datasources.md).
	 */
	const fromRepo = editing?.source === "git";
	/**
	 * The connection fields are read-only for both, for different
	 * reasons: a predefined one comes from server configuration, an
	 * imported one from a committed file. What differs is that an
	 * imported datasource still has settings this project owns — the
	 * password, `read only` and `show all schemas` — so its form is not
	 * a dead page (docs/spec/git-datasources.md).
	 */
	const readOnly = editing?.source === "predefined" || fromRepo;
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
			params: editing.params,
			readOnly: editing.readOnly,
			showAllSchemas: editing.showAllSchemas,
		};
	});
	/**
	 * The three settings this project owns about an imported datasource.
	 * `undefined` means untouched, so a save that only sets a password
	 * does not also assert an opinion about `read only`.
	 */
	const [repoPassword, setRepoPassword] = useState<string | undefined>(
		undefined,
	);
	const [repoReadOnly, setRepoReadOnly] = useState<boolean | undefined>(
		undefined,
	);
	const [repoShowAll, setRepoShowAll] = useState<boolean | undefined>(
		undefined,
	);
	/**
	 * What the repository asks for, and whether a password is already
	 * stored here — so the form can show what an override is overriding
	 * rather than presenting a toggle with no reference point.
	 */
	/**
	 * The paste box. `notes` outlives the input being cleared, because the
	 * reason a parameter could not be honoured is the part worth reading
	 * after the fields have filled in.
	 */
	const [pasted, setPasted] = useState("");
	const [pasteError, setPasteError] = useState<string | null>(null);
	const [pasteNotes, setPasteNotes] = useState<IgnoredParam[]>([]);
	const [repoDefaults, setRepoDefaults] = useState<GitDatasource | null>(null);
	useEffect(() => {
		if (!fromRepo || editing === null) {
			return;
		}
		let cancelled = false;
		void wsClient
			.request<GitDatasource>("git.datasource.reload", {
				connectionRef: editing.id,
			})
			.then((repo) => {
				if (!cancelled) {
					setRepoDefaults(repo);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [fromRepo, editing]);

	const repoOptionsDirty =
		fromRepo &&
		(repoPassword !== undefined ||
			repoReadOnly !== undefined ||
			repoShowAll !== undefined);

	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<ConnectionTestResult | null>(
		null,
	);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	/*
	 * The export path is workspace-local configuration *about* a
	 * datasource rather than part of its definition, so it saves through
	 * its own action — but it saves on the form's single `save`, not a
	 * button of its own. Two save buttons in one form means one of two
	 * things is true and the reader cannot tell which, so they press both
	 * (docs/brand/mocks/datasource-settings.html "The two save buttons").
	 *
	 * `check path` is a validation step, not a save: it asks the server
	 * whether it can actually write there — the directory has to exist,
	 * be absolute, and be inside `HOST_FS_ROOTS` where a deployment set
	 * one — and shows the answer inline.
	 */
	const [exportPath, setExportPath] = useState(editing?.domainExportPath ?? "");
	const [pathCheck, setPathCheck] = useState<DomainExportPathCheck | null>(
		null,
	);
	const [checking, setChecking] = useState(false);
	const pathDirty =
		editing !== null && exportPath !== (editing.domainExportPath ?? "");

	const checkPath = async () => {
		setChecking(true);
		setPathCheck(null);
		try {
			setPathCheck(
				await wsClient.request<DomainExportPathCheck>(
					"domain.set-export-path",
					{
						connectionRef: editing?.id ?? "",
						path: exportPath.trim(),
						checkOnly: true,
						idempotencyKey: crypto.randomUUID(),
					},
				),
			);
		} catch (cause) {
			setPathCheck({
				ok: false,
				resolved: null,
				message: cause instanceof Error ? cause.message : "Could not check it",
			});
		} finally {
			setChecking(false);
		}
	};

	const commitExportPath = async (connectionRef: string) => {
		await wsClient.request("domain.set-export-path", {
			connectionRef,
			path: exportPath.trim(),
			checkOnly: false,
			idempotencyKey: crypto.randomUUID(),
		});
	};

	/*
	 * Datasource paths (docs/spec/datasource-paths.md): the project
	 * directories this datasource brings with it, each of which becomes a
	 * sidebar section above the workspace files. Same nature as the export
	 * directory — workspace-local configuration *about* a datasource — so
	 * they save the same way, on the form's single save, and a predefined
	 * datasource can carry them too.
	 *
	 * `key` is a render key, not an identity: a row added here has no id
	 * until the server assigns one, and two blank rows must still be two
	 * rows.
	 */
	const [paths, setPaths] = useState<PathRow[]>(() =>
		(editing?.paths ?? []).map(toRow),
	);
	const [pathChecks, setPathChecks] = useState<Record<string, HostPathCheck>>(
		{},
	);
	// A git datasource's paths come from its repository, so the form has
	// nothing to save: `datasource.set-paths` would be overwritten by the
	// next read of `config.yaml` anyway.
	const pathsDirty =
		!fromRepo &&
		pathsSignature(paths) !== pathsSignature((editing?.paths ?? []).map(toRow));

	const patchPath = (key: string, partial: Partial<PathRow>) => {
		setPaths((current) =>
			current.map((row) => (row.key === key ? { ...row, ...partial } : row)),
		);
		setPathChecks((current) => {
			const { [key]: _cleared, ...rest } = current;
			return rest;
		});
	};

	const checkDatasourcePath = async (row: PathRow) => {
		const result = await wsClient
			.request<HostPathCheck>("datasource.check-path", {
				path: row.path.trim(),
			})
			.catch((cause: unknown) => ({
				ok: false,
				resolved: null,
				message: cause instanceof Error ? cause.message : "Could not check it",
			}));
		setPathChecks((current) => ({ ...current, [row.key]: result }));
	};

	const commitPaths = async (connectionRef: string) => {
		await wsClient.request("datasource.set-paths", {
			connectionRef,
			paths: paths
				.filter((row) => row.name.trim() !== "" && row.path.trim() !== "")
				.map((row) => ({
					...(row.id === undefined ? {} : { id: row.id }),
					name: row.name.trim(),
					path: row.path.trim(),
				})),
			idempotencyKey: crypto.randomUUID(),
		});
	};

	const applyPasted = () => {
		const result = parseConnectionString(pasted);
		if (!result.ok) {
			setPasteError(result.error);
			setPasteNotes([]);
			return;
		}
		setDraft((current) => applyParsed(current, result.parsed.fields));
		setPasteError(null);
		setPasteNotes(result.parsed.ignored);
		// The string held a plaintext password; there is no reason for it to
		// stay in the DOM once the fields have it.
		setPasted("");
	};

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
	// A predefined datasource can still be saved when its export directory
	// changed — that field is not part of the datasource definition.
	const canSave = readOnly
		? pathDirty || pathsDirty || repoOptionsDirty
		: draft.name.trim().length > 0 &&
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
				await useConnectionsStore
					.getState()
					// A predefined or imported datasource is tested by id: its
					// secret lives on the server and there is no draft password
					// to send in its place.
					.testDraft(
						draft,
						readOnly && editing !== null ? editing.id : editingId,
					),
			);
		} finally {
			setTesting(false);
		}
	};

	const save = async () => {
		setSaving(true);
		setSaveError(null);
		try {
			// A predefined datasource has nothing else to commit: its fields
			// come from server configuration, and the export directory is the
			// one thing this project owns about it.
			if (fromRepo && editing !== null && repoOptionsDirty) {
				await wsClient.request("git.datasource.set-options", {
					connectionRef: editing.id,
					...(repoPassword !== undefined ? { password: repoPassword } : {}),
					...(repoReadOnly !== undefined ? { readOnly: repoReadOnly } : {}),
					...(repoShowAll !== undefined ? { showAllSchemas: repoShowAll } : {}),
					idempotencyKey: crypto.randomUUID(),
				});
				setRepoPassword(undefined);
				setRepoReadOnly(undefined);
				setRepoShowAll(undefined);
			}
			if (readOnly) {
				if (editing !== null) {
					if (pathDirty) {
						await commitExportPath(editing.id);
					}
					if (pathsDirty) {
						await commitPaths(editing.id);
					}
					await useConnectionsStore.getState().load();
				}
				props.panel.api.close();
				return;
			}
			const id = await useConnectionsStore
				.getState()
				.saveDraft(draft, editingId);
			const ref = editingId ?? id;
			if (ref !== null && pathDirty) {
				await commitExportPath(ref);
			}
			if (ref !== null && pathsDirty) {
				await commitPaths(ref);
			}
			// `saveDraft` already reloaded, but that was before these two
			// committed — and the sidebar's path sections come off the
			// connection list, so a stale one leaves the sections behind.
			if (ref !== null && (pathDirty || pathsDirty)) {
				await useConnectionsStore.getState().load();
			}
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

	/*
	 * The rail (docs/brand/mocks/datasource-settings.html "Width").
	 *
	 * `state` is what you want in front of you while filling the form in:
	 * whether it is reachable, the connection string the fields actually
	 * resolve to — the fastest way to spot a wrong port — and the test
	 * log. `help` explains the fields. The rail toggles between them
	 * rather than stacking two columns.
	 */
	// The same writer the paste box reads back, so the string shown here
	// and the string this form accepts cannot drift into two dialects. It
	// takes no password argument at all: this is read on screen.
	const connectionString = formatConnectionString(draft);

	const status: { text: string; tone: "ok" | "bad" | "dim" } = testing
		? { text: "testing…", tone: "dim" }
		: testResult === null
			? { text: "unknown", tone: "dim" }
			: testResult.ok
				? { text: "reachable", tone: "ok" }
				: { text: "unreachable", tone: "bad" };

	const stateRail = (
		<>
			<RailSection title="connection">
				<RailFact label="status" value={status.text} tone={status.tone} />
				<RailFact label="engine" value={draft.adapter} />
				<RailFact
					label="source"
					value={editing === null ? "new" : (editing.source ?? "managed")}
				/>
				<RailFact
					label="export"
					value={exportPath.trim() === "" ? "not set" : "set"}
					tone={exportPath.trim() === "" ? "dim" : undefined}
				/>
				<RailFact
					label="paths"
					value={paths.length === 0 ? "none" : String(paths.length)}
					tone={paths.length === 0 ? "dim" : undefined}
				/>
				<div className="dg-rail-conn">{connectionString}</div>
			</RailSection>
			<RailSection title="test log">
				<div className="dg-rail-log">
					{testing && <div>connecting…</div>}
					{!testing && testResult === null && (
						<div className="dg-rail-dim">Not tested since the last change.</div>
					)}
					{!testing && testResult !== null && testResult.ok && (
						<>
							<div>connected to {draft.host || draft.databaseName}</div>
							{testResult.latencyMs !== undefined && (
								<div>round trip {testResult.latencyMs} ms</div>
							)}
							<div className="dg-rail-ok">
								{testResult.serverVersion?.split(",")[0] ?? "server reached"}
							</div>
						</>
					)}
					{!testing && testResult !== null && !testResult.ok && (
						<div className="dg-rail-bad">
							{testResult.error?.message ?? "connection failed"}
						</div>
					)}
				</div>
			</RailSection>
		</>
	);

	const helpRail = (
		<RailHelp>
			<p>
				A datasource is one database this project can reach. Credentials are
				stored with the project and encrypted; they never travel to the browser.
			</p>
			<dl>
				<dt>read only</dt>
				<dd>
					Refuses writes here, before the statement reaches the database. A
					safety net over the role's own grants, not a replacement for them.
				</dd>
				<dt>show all {NAMESPACE_PLURALS[draft.adapter]}</dt>
				<dd>
					Adds a {NAMESPACE_LABELS[draft.adapter]} level to the tree for cross-
					{NAMESPACE_LABELS[draft.adapter]} work. Off keeps the tree scoped to
					one.
				</dd>
				<dt>domain export directory</dt>
				<dd>
					Where this datasource's domain dump is written. Per datasource,
					because an export never crosses a datasource boundary.{" "}
					<b>check path</b> asks the server whether it can write there.
				</dd>
				<dt>paths</dt>
				<dd>
					Directories that belong with this datasource — a migrations checkout,
					the queries the team keeps. Each becomes a section in the left bar
					above the workspace files while this datasource is active, titled with
					the name you give it. Opening a file caches it as a workspace
					document, so it gets the same live editing as a shared file, and every
					save writes the file back.
				</dd>
			</dl>
			{editing !== null && (
				<>
					<p>Once it has a directory:</p>
					<button
						type="button"
						className="dg-rail-link"
						onClick={() => openDomainManager(editing.id)}
					>
						domains → tag the objects
					</button>
					<br />
					<button
						type="button"
						className="dg-rail-link"
						onClick={() => openSyncPanel(editing.id, editing.name)}
					>
						sync → write and commit the dump
					</button>
				</>
			)}
		</RailHelp>
	);

	return (
		<TabShell
			rail={[
				{ id: "state", label: "state", node: stateRail },
				{ id: "help", label: "help", node: helpRail },
			]}
		>
			<h3 className="dg-form-title">
				{editing === null ? "New datasource" : `Edit ${editing.name}`}
			</h3>
			<p className="dg-form-lead">
				{editing === null ? (
					<>
						Added to <b>{props.workspaceName ?? "this project"}</b>. Credentials
						are stored in the project, not globally.
					</>
				) : fromRepo ? (
					<>
						Defined by <code>.datagripe/config.yaml</code> in its repository.
						Edit that file to change it — the repository section in the left bar
						commits the change.
					</>
				) : readOnly ? (
					"Defined by server configuration — read-only."
				) : (
					<>
						Stored in <b>{props.workspaceName ?? "this project"}</b>. Leave the
						password blank to keep the current one.
					</>
				)}
			</p>

			{/* Above the engine picker because it sets the engine too: the
				    scheme decides it, and a box that filled six fields but left
				    the seventh to be noticed would be worse than no box. Only
				    when creating — a paste rewrites a connection wholesale,
				    which is not an edit. */}
			{editing === null && !readOnly && (
				<div className="dg-form-section">
					<span className="dg-form-section-title">
						paste a connection string
					</span>
					<p className="dg-form-hint">
						Read here in your browser and never sent anywhere — the fields below
						are what gets saved. The box is cleared once it has filled them in.
					</p>
					<div className="dg-paste-row">
						<input
							type="text"
							value={pasted}
							placeholder="postgresql://user:password@host/database?sslmode=require"
							spellCheck={false}
							autoComplete="off"
							onChange={(event) => setPasted(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									applyPasted();
								}
							}}
						/>
						<button
							type="button"
							disabled={pasted.trim() === ""}
							onClick={applyPasted}
						>
							fill in
						</button>
					</div>
					{pasteError !== null && (
						<p className="dg-test-failed">{pasteError}</p>
					)}
					{pasteNotes.length > 0 && (
						<ul className="dg-paste-notes">
							{pasteNotes.map((note) => (
								<li key={`${note.key}:${note.value}`}>
									<code>{note.key}</code>{" "}
									{note.reason === "unsupported"
										? "is not applied"
										: "was left out"}{" "}
									— {note.detail}
								</li>
							))}
						</ul>
					)}
				</div>
			)}

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
							{TLS_MODES.map((mode) => (
								<option key={mode} value={mode}>
									{mode}
								</option>
							))}
						</select>
					</label>
				)}
			</div>

			{/* Runtime parameters, for the engines that have them. A fixed
				    list rather than free-form name/value rows: PostgreSQL
				    answers an unrecognised one with a FATAL at connect time, so
				    a typed-in name is a datasource that cannot connect, and the
				    error would name the parameter rather than the field. */}
			{has("params") && (
				<div className="dg-form-section">
					<span className="dg-form-section-title">runtime parameters</span>
					<p className="dg-form-hint">
						Sent when the connection opens. Visible to everyone in the project —
						not a place for a secret.
					</p>
					{Object.entries(RUNTIME_PARAMS).map(([name, info]) => (
						<label className="dg-field dg-field-path" key={name}>
							<span>{name}</span>
							<input
								type="text"
								value={draft.params[name] ?? ""}
								disabled={readOnly}
								spellCheck={false}
								autoComplete="off"
								placeholder="unset"
								onChange={(event) => {
									const next = { ...draft.params };
									// An empty field is the absence of the parameter, not
									// an empty one: PostgreSQL would take `search_path=''`
									// literally and resolve nothing.
									if (event.target.value.trim() === "") {
										delete next[name];
									} else {
										next[name] = event.target.value;
									}
									patch({ params: next });
								}}
							/>
							<span className="dg-form-hint">{info.description}</span>
						</label>
					))}
				</div>
			)}

			{/* Behaviour, not "more fields": read-only is a connection
				    constraint and show-all-schemas is a display preference. Same
				    control shape, different meaning, so they get a section and
				    their explanations attached rather than orphaned below. */}
			<div className="dg-form-section">
				<span className="dg-form-section-title">behaviour</span>
				{has("readOnly") && (
					<Toggle
						// An imported datasource's toggles are this project's, not
						// the repository's: somebody who imported a repo to look at
						// production should be able to keep read-only on without
						// opening a pull request against a repo they may not own.
						on={fromRepo ? (repoReadOnly ?? editing.readOnly) : draft.readOnly}
						disabled={readOnly && !fromRepo}
						title="read only"
						description="Rejects any statement that would write, before it reaches the database. Independent of what the role itself is allowed to do."
						onChange={(on) => {
							if (fromRepo) {
								setRepoReadOnly(on);
							} else {
								patch({ readOnly: on });
							}
						}}
					/>
				)}
				{/* SQLite has exactly one namespace, so the setting would be a
					    no-op there. */}
				{draft.adapter !== "sqlite" && (
					<Toggle
						on={
							fromRepo
								? (repoShowAll ?? editing.showAllSchemas)
								: draft.showAllSchemas
						}
						disabled={readOnly && !fromRepo}
						title={`show all ${NAMESPACE_PLURALS[draft.adapter]} in the tree`}
						description={`The tree gains a ${NAMESPACE_LABELS[draft.adapter]} level you can expand several of at once, for cross-${NAMESPACE_LABELS[draft.adapter]} joins. Off scopes the tree to the ${NAMESPACE_LABELS[draft.adapter]} picked in the breadcrumb.`}
						onChange={(on) => {
							if (fromRepo) {
								setRepoShowAll(on);
							} else {
								patch({ showAllSchemas: on });
							}
						}}
					/>
				)}
				{fromRepo && (
					<p className="dg-form-hint">
						These two are this project's, not the repository's. It asks for read
						only <b>{repoDefaults?.repoReadOnly === true ? "on" : "off"}</b> and
						show all{" "}
						<b>{repoDefaults?.repoShowAllSchemas === true ? "on" : "off"}</b>.
						Changing them here does not touch <code>config.yaml</code>.
					</p>
				)}
			</div>

			{/* The password an imported datasource may need. Never written to
				    the repository: `config.yaml` is committed, and it names an
				    environment variable instead (docs/spec/git-datasources.md). */}
			{fromRepo && editing !== null && (
				<div className="dg-form-section">
					<span className="dg-form-section-title">password</span>
					<p className="dg-form-hint">
						{editing.unavailable !== null ? (
							<span className="dg-test-failed">{editing.unavailable}</span>
						) : repoDefaults?.hasStoredPassword === true ? (
							"A password is stored for this project, encrypted. Type a new one to replace it, or clear it to fall back to the repository's passwordEnv."
						) : (
							"Set on the server that runs DataGripe, usually through the passwordEnv the repository names. You can store one here instead — it stays in this project, encrypted, and never goes near the repository."
						)}
					</p>
					<label className="dg-field">
						<span>Password</span>
						<input
							type="password"
							value={repoPassword ?? ""}
							placeholder={
								repoDefaults?.hasStoredPassword === true
									? "Stored — type to replace"
									: "Leave blank to use the repository's passwordEnv"
							}
							onChange={(event) => setRepoPassword(event.target.value)}
						/>
					</label>
					{repoDefaults?.hasStoredPassword === true && (
						<button
							type="button"
							className="dg-btn"
							onClick={() => setRepoPassword("")}
						>
							clear the stored password
						</button>
					)}
				</div>
			)}

			{/* Only on an existing datasource: the path is keyed by the
				    connection ref, which a draft does not have yet. */}
			{editing !== null && (
				<div className="dg-form-section">
					<span className="dg-form-section-title">domain export</span>
					<div className="dg-field dg-field-path">
						<label htmlFor="dg-export-path">
							<span>Directory</span>
						</label>
						<input
							id="dg-export-path"
							value={exportPath}
							placeholder="/home/you/repo/datasource/schema"
							onChange={(event) => {
								setExportPath(event.target.value);
								setPathCheck(null);
							}}
						/>
						<p className="dg-form-hint">
							Where this datasource's domain dump is written. Per datasource —
							an export never crosses a datasource boundary, and two sharing a
							directory would overwrite each other's tree. Saved with the rest
							of the form.
							{fromRepo && (
								<>
									{" "}
									For this datasource it is written to{" "}
									<code>.datagripe/sync.yaml</code> in the repository, relative
									to the repository root, so a teammate who pulls gets the same
									target.
								</>
							)}
						</p>
						<div className="dg-field-inline">
							<button
								type="button"
								className="dg-btn"
								disabled={checking}
								onClick={() => void checkPath()}
							>
								{checking ? "checking…" : "check path"}
							</button>
							{pathCheck !== null && (
								<span
									className={pathCheck.ok ? "dg-test-ok" : "dg-test-failed"}
								>
									{pathCheck.resolved ?? pathCheck.message}
								</span>
							)}
						</div>
					</div>
				</div>
			)}

			{/* Only on an existing datasource, for the same reason as the
				    export directory: the rows are keyed by the connection ref,
				    which a draft does not have yet. */}
			{editing !== null && !fromRepo && (
				<ExportConfigPanel
					connectionRef={editing.id}
					{...(editing.domainExportPath !== null
						? { suggestedDir: editing.domainExportPath }
						: {})}
				/>
			)}

			{editing !== null && fromRepo && (
				<GitDatasourceRepo connection={editing} panel={props.panel} />
			)}

			{editing !== null && fromRepo && (
				<div className="dg-form-section">
					<span className="dg-form-section-title">paths</span>
					<p className="dg-form-hint">
						From <code>.datagripe/config.yaml</code>, relative to the repository
						root. Add or remove them by editing that file; every teammate who
						pulls the repo gets the same sections.
					</p>
					{editing.paths.length === 0 && (
						<p className="dg-form-hint dg-rail-dim">
							No <code>paths:</code> in the config yet.
						</p>
					)}
					<ul className="dg-repo-paths">
						{editing.paths.map((entry) => (
							<li key={entry.id}>
								<b>{entry.name}</b> <code>{entry.path}</code>
							</li>
						))}
					</ul>
				</div>
			)}

			{editing !== null && !fromRepo && (
				<div className="dg-form-section">
					<span className="dg-form-section-title">paths</span>
					<p className="dg-form-hint">
						Project directories this datasource brings with it. Each pair
						becomes its own section in the left bar, above the workspace files,
						whenever this datasource is the active one — the name is the
						section's title. Files open in the editor and save back to disk.
					</p>
					{paths.length === 0 && (
						<p className="dg-form-hint dg-rail-dim">
							No paths yet. A checkout of the migrations that built this
							database is the usual first one.
						</p>
					)}
					{paths.map((row) => {
						const check = pathChecks[row.key];
						return (
							<div key={row.key} className="dg-path-row">
								<label className="dg-field">
									<span>Name</span>
									<input
										value={row.name}
										placeholder="migrations"
										onChange={(event) =>
											patchPath(row.key, { name: event.target.value })
										}
									/>
								</label>
								<label className="dg-field">
									<span>Directory</span>
									<input
										value={row.path}
										placeholder="/home/you/repo/db/migrations"
										onChange={(event) =>
											patchPath(row.key, { path: event.target.value })
										}
									/>
								</label>
								<div className="dg-field-inline">
									<button
										type="button"
										className="dg-btn"
										disabled={row.path.trim() === ""}
										onClick={() => void checkDatasourcePath(row)}
									>
										check
									</button>
									<button
										type="button"
										className="dg-btn"
										aria-label={`Remove ${row.name.trim() === "" ? "this path" : row.name}`}
										onClick={() => {
											setPaths((current) =>
												current.filter((entry) => entry.key !== row.key),
											);
										}}
									>
										remove
									</button>
									{check !== undefined && (
										<span
											className={check.ok ? "dg-test-ok" : "dg-test-failed"}
										>
											{check.resolved ?? check.message}
										</span>
									)}
								</div>
							</div>
						);
					})}
					<button
						type="button"
						className="dg-doc-new"
						onClick={() =>
							setPaths((current) => [
								...current,
								{ key: crypto.randomUUID(), name: "", path: "" },
							])
						}
					>
						+ add a path
					</button>
					{/* Removing a pair here closes its files rather than deleting
						    them: the files on disk are never touched, and anything
						    unsaved is archived, not dropped. */}
				</div>
			)}

			{saveError !== null && <p className="dg-test-failed">{saveError}</p>}

			<div className="dg-frow">
				<button
					type="button"
					className="dg-btn"
					disabled={testing}
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
					{saving ? "saving…" : editing === null ? "save and connect" : "save"}
				</button>
				{/* Read-only means read-only: say where the values come from
					    rather than offering controls that cannot commit. */}
				{fromRepo ? (
					<span className="dg-form-note">
						Connection details come from <code>.datagripe/config.yaml</code>.
						The password, the two toggles and the paths below are this project's
						and save here.
					</span>
				) : readOnly ? (
					<span className="dg-form-note">
						Connection details come from server configuration. The export
						directory is this project's setting and saves here.
					</span>
				) : (
					<span className={testlineClass}>{testline}</span>
				)}
			</div>
		</TabShell>
	);
}
