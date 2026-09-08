import type {
	DomainExportResult,
	DomainGitResult,
	DomainImportResult,
	DomainRunsResult,
	ExportPlan,
} from "@datagripe/contracts";
import { useCallback, useEffect, useState } from "react";
import { wsClient } from "../api/ws";
import {
	openAccessPanel,
	openConnectionForm,
	openDomainManager,
	readDatasourcePanelParams,
} from "../app/viewPanels";
import { useConnectionsStore } from "../stores/runtime";
import { RailFact, RailHelp, RailSection, TabShell } from "./TabRail";

/**
 * The sync tab (docs/spec/domains.md "The sync tab").
 *
 * Export is not a modal: what it produces is a run you watch, read the
 * output of, and act on, and a modal cannot stay open beside the diff it
 * just made.
 *
 * Three sections in order, answering the three questions: what am I
 * pointed at, what is about to happen, what happened before.
 */

type Progress = { done: number; total: number; current: string };

function planLine(entry: ExportPlan["entries"][number]): string {
	return entry.reason === undefined
		? entry.path
		: `${entry.path} — ${entry.reason}`;
}

export function SyncPanel(props: { params?: unknown }) {
	const { connectionRef, connectionName } = readDatasourcePanelParams(
		props.params,
	);
	const [runs, setRuns] = useState<DomainRunsResult | null>(null);
	const [plan, setPlan] = useState<ExportPlan | null>(null);
	const [runId, setRunId] = useState<string | null>(null);
	const [progress, setProgress] = useState<Progress | null>(null);
	const [git, setGit] = useState<DomainGitResult | null>(null);
	const [imported, setImported] = useState<DomainImportResult | null>(null);
	const [message, setMessage] = useState("schema snapshot");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const connection = useConnectionsStore((state) =>
		state.connections.find((entry) => entry.id === connectionRef),
	);

	const refresh = useCallback(async () => {
		try {
			setRuns(
				await wsClient.request<DomainRunsResult>("domain.runs", {
					connectionRef,
					limit: 20,
				}),
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not load runs");
		}
	}, [connectionRef]);

	useEffect(() => {
		if (connectionRef !== "") {
			void refresh();
		}
	}, [connectionRef, refresh]);

	// Export runs long — one describe per object — so it reports as it
	// goes rather than leaving a spinner to guess against.
	useEffect(() => {
		return wsClient.onEvent((event) => {
			if (event.topic !== "domain.export.progress") {
				return;
			}
			const payload = event.payload;
			if (
				payload === null ||
				typeof payload !== "object" ||
				!("done" in payload)
			) {
				return;
			}
			const update = payload as Progress & { connectionRef?: string };
			// Two datasources can export at once; only ours moves this bar.
			if (update.connectionRef !== connectionRef) {
				return;
			}
			setProgress({
				done: update.done,
				total: update.total,
				current: update.current,
			});
		});
	}, [connectionRef]);

	const run = async (dryRun: boolean) => {
		setBusy(true);
		setError(null);
		setGit(null);
		setProgress(null);
		try {
			const result = await wsClient.request<DomainExportResult>(
				"domain.export",
				{ connectionRef, dryRun, idempotencyKey: crypto.randomUUID() },
			);
			setPlan(result.plan);
			setRunId(result.runId);
			if (!dryRun) {
				await refresh();
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Export failed");
		} finally {
			setBusy(false);
			setProgress(null);
		}
	};

	const runImport = async (dryRun: boolean) => {
		setBusy(true);
		setError(null);
		try {
			setImported(
				await wsClient.request<DomainImportResult>("domain.import", {
					connectionRef,
					dryRun,
					idempotencyKey: crypto.randomUUID(),
				}),
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Import failed");
		} finally {
			setBusy(false);
		}
	};

	const commit = async (push: boolean) => {
		setBusy(true);
		setError(null);
		try {
			const result = await wsClient.request<DomainGitResult>("domain.git", {
				connectionRef,
				operation: push ? "commit-and-push" : "commit",
				message,
				...(runId === null ? {} : { runId }),
			});
			setGit(result);
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "git failed");
		} finally {
			setBusy(false);
		}
	};

	if (connectionRef === "") {
		return (
			<div className="dg-form dg-scroll">
				<div className="dg-form-body">
					<h3 className="dg-form-title">Sync</h3>
					<p className="dg-form-lead">No datasource selected.</p>
				</div>
			</div>
		);
	}

	const deletions = plan?.entries.filter((e) => e.action === "deleted") ?? [];
	const refusals = plan?.entries.filter((e) => e.action === "refused") ?? [];
	const writes = plan?.entries.filter((e) => e.action === "written") ?? [];

	const stateRail = (
		<>
			<RailSection title="target">
				<RailFact
					label="export"
					value={runs?.exportEnabled === false ? "disabled" : "enabled"}
					tone={runs?.exportEnabled === false ? "bad" : "ok"}
				/>
				<RailFact
					label="git"
					value={runs?.gitEnabled === true ? "on" : "off"}
					tone={runs?.gitEnabled === true ? "ok" : "dim"}
				/>
				<RailFact label="runs" value={runs?.runs.length ?? 0} />
				{runs?.root !== null && runs?.root !== undefined && (
					<div className="dg-rail-conn">{runs.root}</div>
				)}
			</RailSection>
			{plan !== null && (
				<RailSection title="last plan">
					<RailFact label="unchanged" value={plan.unchanged} />
					<RailFact label="written" value={plan.written} />
					<RailFact
						label="deleted"
						value={plan.deleted}
						tone={plan.deleted > 0 ? "bad" : "dim"}
					/>
					<RailFact
						label="refused"
						value={plan.refused}
						tone={plan.refused > 0 ? "bad" : "dim"}
					/>
					<RailFact
						label="untagged"
						value={plan.untaggedCount}
						tone={plan.untaggedCount > 0 ? "bad" : "ok"}
					/>
				</RailSection>
			)}
		</>
	);

	const help = (
		<RailHelp>
			<p>
				Sync writes this datasource's structure to a directory you can commit.
				One file per tagged object — its DDL, then its grants — plus the access
				reports and a manifest.
			</p>
			<dl>
				<dt>dry run</dt>
				<dd>
					Builds the plan and writes nothing. Read it first: an export deletes
					files it no longer generates, and those are files in a git working
					tree.
				</dd>
				<dt>export</dt>
				<dd>
					Writes the plan. Re-running against an unchanged database produces an
					empty <code>git diff</code> — no dates, no sizes, fixed ordering — so
					a real change is never buried.
				</dd>
				<dt>refused</dt>
				<dd>
					Objects deliberately not written, each with a reason. A silently
					omitted object is the failure mode this replaces.
				</dd>
				<dt>untagged</dt>
				<dd>
					Objects no domain claims. They are not exported, and the count is how
					you notice a table added since last time.
				</dd>
				<dt>import</dt>
				<dd>
					The other direction: reads <code>manifest.json</code> back so a
					teammate who pulled the repo gets your tagging. A replace, so it
					previews first.
				</dd>
			</dl>
			<p>
				Committing runs your local <code>git</code> with your own configuration.{" "}
				<code>add</code> is scoped to the export directory, so other work in the
				repository stays unstaged. Push is always a separate press.
			</p>
			<button
				type="button"
				className="dg-rail-link"
				onClick={() => openDomainManager(connectionRef)}
			>
				domains → what gets exported, and where
			</button>
			<br />
			<button
				type="button"
				className="dg-rail-link"
				onClick={() => openAccessPanel(connectionRef, connectionName)}
			>
				access report → what goes in <code>access/</code>
			</button>
		</RailHelp>
	);

	return (
		<TabShell
			className="dg-form-body dg-form-wide dg-sync"
			rail={[
				{ id: "state", label: "state", node: stateRail },
				{ id: "help", label: "help", node: help },
			]}
		>
			<h3 className="dg-form-title">sync: {connectionName}</h3>

			<dl className="dg-sync-target">
				<dt>target</dt>
				<dd>
					{runs?.exportEnabled === false ? (
						// Off at the deployment level, and the UI says so rather
						// than offering a button that always fails.
						<span className="dg-sync-off">
							export is off — HOST_FS_DISABLED is set on this server
						</span>
					) : (
						(runs?.root ?? (
							<span className="dg-sync-off">
								no export directory for this datasource —{" "}
								{/* The setting lives on the datasource, so the fix
									    should be one click from the complaint. */}
								<button
									type="button"
									className="dg-access-object"
									disabled={connection === undefined}
									onClick={() =>
										connection !== undefined && openConnectionForm(connection)
									}
								>
									set one
								</button>
							</span>
						))
					)}
				</dd>
				<dt>scope</dt>
				<dd>
					{plan === null ? (
						<button
							type="button"
							onClick={() => openDomainManager(connectionRef)}
						>
							manage domains
						</button>
					) : (
						<>
							{plan.domainCount} domains · {plan.objectCount} objects ·{" "}
							{/* The number the scripts could never show. */}
							<strong>{plan.untaggedCount} untagged</strong>
						</>
					)}
				</dd>
			</dl>

			<div className="dg-sync-actions">
				<button
					type="button"
					disabled={busy || runs?.exportEnabled === false}
					onClick={() => void run(true)}
				>
					dry run
				</button>
				<button
					type="button"
					disabled={busy || runs?.exportEnabled === false || plan === null}
					title={
						plan === null ? "Read the plan before anything writes" : undefined
					}
					onClick={() => void run(false)}
				>
					export
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => openAccessPanel(connectionRef, connectionName)}
				>
					access report
				</button>
			</div>

			{/* The other direction: a teammate who pulled the repo gets your
				    tagging back. A replace, so it previews as a diff first. */}
			<div className="dg-sync-actions">
				<button
					type="button"
					disabled={busy || runs?.exportEnabled === false}
					onClick={() => void runImport(true)}
				>
					preview import
				</button>
				<button
					type="button"
					disabled={busy || runs?.exportEnabled === false || imported === null}
					onClick={() => void runImport(false)}
				>
					import tagging
				</button>
				{imported !== null && (
					<span className="dg-sync-import">
						{imported.dryRun ? "would replace" : "replaced"}{" "}
						{imported.tagsBefore} tags with {imported.tagsAfter}
						{imported.domainsAdded.length > 0 &&
							` · +${imported.domainsAdded.join(", ")}`}
						{imported.domainsRemoved.length > 0 &&
							` · −${imported.domainsRemoved.join(", ")}`}
					</span>
				)}
			</div>

			{progress !== null && (
				<div className="dg-sync-progress">
					<progress value={progress.done} max={progress.total} />
					<span>
						{progress.done}/{progress.total} {progress.current}
					</span>
				</div>
			)}

			{error !== null && <div className="dg-modal-error">{error}</div>}

			{plan !== null && (
				<section className="dg-sync-plan">
					<h4>
						plan {plan.dryRun && <span className="dg-sync-dry">dry run</span>}
					</h4>
					{deletions.length > 0 && (
						// A plan whose deletion count is non-zero says so at the
						// top: this deletes files in a git working tree.
						<p className="dg-sync-warn">
							{deletions.length} file
							{deletions.length === 1 ? "" : "s"} will be deleted.
						</p>
					)}
					<ul className="dg-sync-counts">
						<li>{plan.unchanged} unchanged</li>
						<li>{plan.written} written</li>
						<li>{plan.deleted} deleted</li>
						<li>{plan.refused} refused</li>
					</ul>
					{refusals.length > 0 && (
						<div className="dg-sync-refusals">
							{/* Refusals are first-class: a silently omitted object is
								    the failure mode of the scripts this replaces. */}
							<h5>refused</h5>
							<ul>
								{refusals.map((entry) => (
									<li key={entry.path}>{planLine(entry)}</li>
								))}
							</ul>
						</div>
					)}
					{(writes.length > 0 || deletions.length > 0) && (
						<details>
							<summary>
								{writes.length + deletions.length} changed files
							</summary>
							<ul className="dg-sync-files">
								{deletions.map((entry) => (
									<li key={entry.path} className="dg-sync-deleted">
										− {entry.path}
									</li>
								))}
								{writes.map((entry) => (
									<li key={entry.path}>+ {entry.path}</li>
								))}
							</ul>
						</details>
					)}
				</section>
			)}

			{/* Absent, not disabled-with-a-tooltip, when git is off. */}
			{runs?.gitEnabled === true && (
				<section className="dg-sync-git">
					<h4>commit</h4>
					<input
						value={message}
						aria-label="Commit message"
						onChange={(event) => setMessage(event.target.value)}
					/>
					<div className="dg-sync-actions">
						<button
							type="button"
							disabled={busy || message.trim() === ""}
							onClick={() => void commit(false)}
						>
							commit…
						</button>
						{/* Push is always a separate press: it is the only action
							    here that leaves the machine. */}
						<button
							type="button"
							disabled={busy || message.trim() === ""}
							onClick={() => void commit(true)}
						>
							commit and push…
						</button>
					</div>
					{git !== null && (
						<div className="dg-sync-gitout">
							<div>
								{git.branch ?? "detached"} · exit {git.exitCode}
								{git.commitSha !== null && ` · ${git.commitSha.slice(0, 8)}`}
							</div>
							{/* Verbatim. No interpretation, no "something went wrong". */}
							{git.stdout !== "" && <pre>{git.stdout}</pre>}
							{git.stderr !== "" && (
								<pre className="dg-sync-stderr">{git.stderr}</pre>
							)}
						</div>
					)}
				</section>
			)}

			<section className="dg-sync-history">
				<h4>history</h4>
				{runs === null && <p className="dg-tree-note">loading…</p>}
				{runs !== null && runs.runs.length === 0 && (
					<p className="dg-tree-note">no exports yet</p>
				)}
				{runs !== null && runs.runs.length > 0 && (
					<table className="dg-domain-table">
						<thead>
							<tr>
								<th>when</th>
								<th>who</th>
								<th>objects</th>
								<th>written</th>
								<th>deleted</th>
								<th>outcome</th>
								<th>commit</th>
							</tr>
						</thead>
						<tbody>
							{runs.runs.map((entry) => (
								<tr key={entry.id}>
									<td>{entry.startedAt.replace("T", " ").slice(0, 19)}</td>
									<td>{entry.actorEmail ?? "—"}</td>
									<td className="dg-domain-count">{entry.objectCount}</td>
									<td className="dg-domain-count">{entry.written}</td>
									<td className="dg-domain-count">{entry.deleted}</td>
									<td
										className={
											entry.outcome === "failed" ? "dg-sync-failed" : ""
										}
										title={entry.error ?? undefined}
									>
										{entry.outcome}
									</td>
									<td>{entry.commitSha?.slice(0, 8) ?? "—"}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>
		</TabShell>
	);
}
