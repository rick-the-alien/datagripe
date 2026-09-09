import { useEffect, useState } from "react";
import { openRunPanel } from "../app/viewPanels";
import { useRepoRunsStore } from "../stores/repoRuns";
import { IconRun } from "./icons";

/**
 * The commands a repository declares, and the approval that gates them
 * (docs/spec/repo-commands.md).
 *
 * This is the only place in DataGripe that offers to run a program it
 * did not write, so the argv is on screen before the button is, and the
 * approval is a separate, explicit press. The important state is not
 * "approved / not approved" but **"changed since it was approved"** —
 * that is the one a `git pull` can produce without anybody noticing, and
 * it gets its own wording.
 */

export function RepoCommands(props: {
	connectionRef: string;
	datasourceName: string;
}) {
	const { connectionRef } = props;
	const state = useRepoRunsStore((s) => s.commands[connectionRef]);
	const error = useRepoRunsStore((s) => s.errors[connectionRef]);
	const [reviewing, setReviewing] = useState(false);

	useEffect(() => {
		void useRepoRunsStore.getState().loadCommands(connectionRef);
	}, [connectionRef]);

	// Nothing to show for a repository that declares no commands — which
	// is most of them.
	if (state === undefined || state.commands.length === 0) {
		return null;
	}

	const changed = state.approvedHash !== null && !state.trusted;

	return (
		<div className="dg-repo-commands">
			<div className="dg-repo-commands-head">
				<span>commands</span>
			</div>

			{error !== undefined && (
				<p className="dg-sidebar-empty dg-test-failed">{error}</p>
			)}

			{state.unavailable !== null && (
				<p className="dg-sidebar-empty dg-rail-dim">{state.unavailable}</p>
			)}

			{state.unavailable === null && !state.trusted && (
				<div className="dg-repo-trust">
					<p className={changed ? "dg-test-failed" : "dg-sidebar-empty"}>
						{changed
							? "These commands changed since they were approved. Read them again before running anything — a pull can bring in a different command under the same name."
							: "This repository declares commands DataGripe can run. Nothing runs until somebody here approves them."}
					</p>
					<button
						type="button"
						className="dg-doc-new"
						onClick={() => setReviewing((open) => !open)}
					>
						{reviewing ? "hide" : "review"} what would run
					</button>
					{reviewing && (
						<ul className="dg-repo-argv">
							{state.commands.map((command) => (
								<li key={command.name}>
									<b>{command.name}</b>
									<code>{command.run.join(" ")}</code>
									{command.description !== "" && <em>{command.description}</em>}
								</li>
							))}
						</ul>
					)}
					{reviewing && (
						<button
							type="button"
							className="dg-doc-new"
							onClick={() =>
								void useRepoRunsStore.getState().approve(connectionRef, true)
							}
						>
							approve these commands
						</button>
					)}
				</div>
			)}

			{state.unavailable === null && state.trusted && (
				<>
					<ul className="dg-repo-commands-list">
						{state.commands.map((command) => (
							<li key={command.name}>
								<button
									type="button"
									className="dg-repo-command"
									title={command.run.join(" ")}
									onClick={() => {
										openRunPanel(connectionRef, props.datasourceName);
										void useRepoRunsStore
											.getState()
											.run(connectionRef, command.name);
									}}
								>
									<span className="dg-repo-command-run">
										<IconRun />
									</span>
									<span className="dg-repo-command-name">{command.name}</span>
								</button>
								{command.description !== "" && (
									<p className="dg-repo-command-desc">{command.description}</p>
								)}
							</li>
						))}
					</ul>
					<button
						type="button"
						className="dg-doc-new"
						onClick={() =>
							void useRepoRunsStore.getState().approve(connectionRef, false)
						}
					>
						withdraw approval
					</button>
				</>
			)}
		</div>
	);
}
