import { GIT_STATUS_MAX_ENTRIES } from "@datagripe/contracts";
import { useEffect, useState } from "react";
import type { EditorDocument } from "../stores/documents";
import { useRepoStore } from "../stores/git";
import { openRepoFile } from "../stores/openRepoFile";
import { useConnectionsStore } from "../stores/runtime";
import { IconAhead, IconBehind } from "./icons";
import { RepoCommands } from "./RepoCommands";

/**
 * The repository section (docs/spec/git-datasources.md
 * "The repository section").
 *
 * Branch, what has changed, and the three buttons. Everything in here
 * is a press: editing a file does not commit it, saving does not push,
 * and nothing refreshes on a timer.
 *
 * The status list is the whole work tree, not the datasource's
 * configured paths. This is a repository view, and hiding a changed file
 * because it sits outside a path pair is how you commit half of
 * something.
 */

export interface RepoSectionProps {
	connectionRef: string;
	/** For the run tab's title. */
	datasourceName: string;
	/** Clicking a row opens the file, when the sidebar can reach it. */
	onOpen?: (doc: EditorDocument) => void;
}

export function RepoSection(props: RepoSectionProps) {
	const { connectionRef } = props;
	const status = useRepoStore((state) => state.status[connectionRef]);
	const loading = useRepoStore(
		(state) => state.loading[connectionRef] === true,
	);
	const error = useRepoStore((state) => state.errors[connectionRef]);
	const selected = useRepoStore((state) => state.selected[connectionRef]);
	const output = useRepoStore((state) => state.output[connectionRef]);
	const busy = useRepoStore((state) => state.busy[connectionRef]);
	const [message, setMessage] = useState("");
	const [composing, setComposing] = useState(false);
	const [openError, setOpenError] = useState<string | null>(null);
	const connection = useConnectionsStore((state) =>
		state.connections.find((entry) => entry.id === connectionRef),
	);

	/**
	 * A row names a file the way git does: relative to the work tree root.
	 * The editor names files relative to a configured path pair. A file
	 * outside every pair is not reachable from here, and says so rather
	 * than opening something else.
	 */
	const openRow = async (repoRelative: string) => {
		setOpenError(null);
		if (connection === undefined || status === undefined) {
			return;
		}
		try {
			const doc = await openRepoFile(connection, status.repoPath, repoRelative);
			if (doc === null) {
				setOpenError(
					`${repoRelative} is not under any of this datasource's paths — add it to .datagripe/config.yaml to open it here.`,
				);
				return;
			}
			props.onOpen?.(doc);
		} catch (cause) {
			setOpenError(
				cause instanceof Error ? cause.message : "Could not open that file",
			);
		}
	};

	useEffect(() => {
		void useRepoStore.getState().load(connectionRef);
	}, [connectionRef]);

	const ticked = selected ?? [];

	if (error !== undefined && status === undefined) {
		return (
			<div className="dg-repo">
				<p className="dg-sidebar-empty dg-test-failed">{error}</p>
				<button
					type="button"
					className="dg-doc-new"
					onClick={() => void useRepoStore.getState().load(connectionRef)}
				>
					try again
				</button>
			</div>
		);
	}

	return (
		<div className="dg-repo">
			<div className="dg-repo-head">
				<span className="dg-repo-branch">{status?.branch ?? "…"}</span>
				{status !== undefined && status.upstream !== null && (
					// The arrows are the git convention, but they are decoration:
					// the count only means something with "ahead"/"behind" said
					// out loud, so the accessible name carries the words.
					<span
						className="dg-repo-track"
						role="img"
						title={`${status.ahead} ahead, ${status.behind} behind`}
						aria-label={`${status.ahead} ahead, ${status.behind} behind`}
					>
						<IconAhead />
						{status.ahead} <IconBehind />
						{status.behind}
					</span>
				)}
				{status !== undefined && status.upstream === null && (
					<span className="dg-repo-track dg-dim">no upstream</span>
				)}
			</div>

			{error !== undefined && (
				<p className="dg-sidebar-empty dg-test-failed">{error}</p>
			)}
			{openError !== null && (
				<p className="dg-sidebar-empty dg-test-failed">{openError}</p>
			)}

			{status === undefined ? (
				<p className="dg-sidebar-empty">
					{loading ? "Reading…" : "Not loaded."}
				</p>
			) : status.entries.length === 0 ? (
				<p className="dg-sidebar-empty">Nothing changed.</p>
			) : (
				<>
					{status.truncated && (
						<p className="dg-sidebar-empty">
							{status.total} changed files — too many to tick through here. Use
							a terminal; the first {GIT_STATUS_MAX_ENTRIES} are listed.
						</p>
					)}
					<ul className="dg-repo-list">
						{status.entries.map((entry) => (
							<li key={entry.path} className="dg-repo-row">
								<label className="dg-repo-check">
									<input
										type="checkbox"
										checked={ticked.includes(entry.path)}
										onChange={() =>
											useRepoStore.getState().toggle(connectionRef, entry.path)
										}
									/>
									{/* Git's own letters, unabbreviated. People who use git
										    read `??` already, and people who do not are not
										    served by an invented word. */}
									<code className="dg-repo-status">
										{entry.status.replaceAll(" ", "·")}
									</code>
								</label>
								<button
									type="button"
									className="dg-repo-path"
									title={
										entry.originalPath === null
											? entry.path
											: `${entry.originalPath} → ${entry.path}`
									}
									onClick={() => void openRow(entry.path)}
								>
									{entry.path}
								</button>
							</li>
						))}
					</ul>
				</>
			)}

			<div className="dg-repo-actions">
				{composing ? (
					<div className="dg-repo-compose">
						<textarea
							className="dg-repo-message"
							rows={2}
							placeholder="Commit message"
							value={message}
							onChange={(event) => setMessage(event.target.value)}
						/>
						<div className="dg-repo-buttons">
							<button
								type="button"
								disabled={message.trim() === "" || busy !== undefined}
								onClick={() => {
									void useRepoStore
										.getState()
										.commit(connectionRef, message)
										.then(() => {
											if (
												useRepoStore.getState().output[connectionRef]
													?.exitCode === 0
											) {
												setMessage("");
												setComposing(false);
											}
										});
								}}
							>
								commit {ticked.length > 0 ? `(${ticked.length})` : ""}
							</button>
							<button type="button" onClick={() => setComposing(false)}>
								cancel
							</button>
						</div>
					</div>
				) : (
					<div className="dg-repo-buttons">
						<button
							type="button"
							disabled={busy !== undefined}
							onClick={() => setComposing(true)}
						>
							commit…
						</button>
						{/* The only button here that leaves the machine, which is
							    why it is always its own press. */}
						<button
							type="button"
							disabled={busy !== undefined}
							onClick={() =>
								void useRepoStore
									.getState()
									.push(connectionRef, status?.upstream === null)
							}
						>
							{busy === "push" ? "pushing…" : "push"}
						</button>
						<button
							type="button"
							disabled={busy !== undefined}
							onClick={() => void useRepoStore.getState().pull(connectionRef)}
						>
							{busy === "pull" ? "pulling…" : "pull"}
						</button>
						<button
							type="button"
							disabled={loading}
							onClick={() => void useRepoStore.getState().load(connectionRef)}
						>
							refresh
						</button>
					</div>
				)}
			</div>

			{/* Commands the repository declares, behind their own approval
				    (docs/spec/repo-commands.md). Below the git buttons because
				    they are a different kind of thing: git moves files around,
				    this runs a program. */}
			<RepoCommands
				connectionRef={connectionRef}
				datasourceName={props.datasourceName}
			/>

			{/* Git's verdict, verbatim: no interpretation, no "something went
				    wrong". A push that failed for want of credentials shows
				    exactly what git said about it. */}
			{output !== undefined && (
				<div className="dg-repo-output">
					<p className="dg-repo-exit">
						exit {output.exitCode}
						{output.commitSha !== null && ` · ${output.commitSha.slice(0, 8)}`}
					</p>
					{output.stdout !== "" && <pre>{output.stdout}</pre>}
					{output.stderr !== "" && (
						<pre className="dg-sync-stderr">{output.stderr}</pre>
					)}
				</div>
			)}
		</div>
	);
}
