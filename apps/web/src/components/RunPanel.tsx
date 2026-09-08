import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef } from "react";
import { useRepoRunsStore } from "../stores/repoRuns";

/**
 * The output of a repository command (docs/spec/repo-commands.md).
 *
 * A dock tab rather than a modal or a sidebar box, for the same reason
 * the sync tab is one: what it produces is a run you watch, read the
 * output of, and act on — and a 240px rail is a bad place to read a
 * database seeding log.
 *
 * The argv is printed above the output, always. The point of this
 * feature is that DataGripe runs a program somebody else wrote; the
 * pane says exactly which one rather than only which button was
 * pressed.
 */

function readParams(params: unknown): { connectionRef: string; name: string } {
	const record = (params ?? {}) as Record<string, unknown>;
	return {
		connectionRef:
			typeof record.connectionRef === "string" ? record.connectionRef : "",
		name:
			typeof record.connectionName === "string" ? record.connectionName : "",
	};
}

export function RunPanel(props: IDockviewPanelProps) {
	const { connectionRef, name } = readParams(props.params);
	const runId = useRepoRunsStore((state) => state.latestByRef[connectionRef]);
	const run = useRepoRunsStore((state) =>
		runId === undefined ? undefined : state.runs[runId],
	);
	const error = useRepoRunsStore((state) => state.errors[connectionRef]);
	const tailRef = useRef<HTMLPreElement>(null);
	const chunks = run?.output.length ?? 0;
	const running = run !== undefined && !run.finished;

	// Follow the tail while it is running, and stop following once it is
	// done so a finished log can be read from the top.
	// biome-ignore lint/correctness/useExhaustiveDependencies: chunks is the scroll trigger
	useEffect(() => {
		if (running) {
			tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
		}
	}, [chunks, running]);

	return (
		<div className="dg-form dg-scroll">
			<div className="dg-form-body">
				<h3 className="dg-form-title">run: {name}</h3>

				{error !== undefined && <p className="dg-test-failed">{error}</p>}

				{run === undefined ? (
					<p className="dg-form-lead">
						Nothing has been run for this datasource in this session. Start a
						command from the <b>repository</b> section in the left bar.
					</p>
				) : (
					<>
						<dl className="dg-repo-facts">
							<dt>command</dt>
							<dd>
								<code>{run.name}</code>
							</dd>
							<dt>argv</dt>
							{/* Exactly what ran, not a paraphrase of it. */}
							<dd>
								<code>{run.argv.join(" ")}</code>
							</dd>
							<dt>cwd</dt>
							<dd>
								<code>{run.cwd}</code>
							</dd>
							<dt>state</dt>
							<dd>
								{run.finished ? (
									run.killed ? (
										<span className="dg-test-failed">
											stopped — {run.reason ?? "killed"}
										</span>
									) : run.exitCode === 0 ? (
										<span className="dg-test-ok">exit 0</span>
									) : (
										<span className="dg-test-failed">
											exit {run.exitCode ?? "?"}
										</span>
									)
								) : (
									<span>running…</span>
								)}
							</dd>
						</dl>

						{!run.finished && (
							<button
								type="button"
								className="dg-btn"
								onClick={() =>
									void useRepoRunsStore.getState().cancel(run.runId)
								}
							>
								stop
							</button>
						)}

						{/* Verbatim, in arrival order, stdout and stderr interleaved
							    as they actually came. Reordering them would make a log
							    that no longer matches what a terminal would have shown. */}
						<pre className="dg-run-output" ref={tailRef}>
							{run.output.map((entry, index) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: chunks are append-only and never reordered
									key={index}
									className={
										entry.stream === "stderr" ? "dg-sync-stderr" : undefined
									}
								>
									{entry.chunk}
								</span>
							))}
							{run.output.length === 0 &&
								!run.finished &&
								"waiting for output…"}
						</pre>
					</>
				)}
			</div>
		</div>
	);
}
