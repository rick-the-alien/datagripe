import type { ConnectionMetadata, GitDatasource } from "@datagripe/contracts";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useState } from "react";
import { wsClient } from "../api/ws";
import { useConnectionsStore } from "../stores/runtime";

/**
 * The repository behind a git datasource, on its edit page
 * (docs/spec/git-datasources.md).
 *
 * Where the checkout is, where it came from, and the one destructive
 * action — which is careful about exactly one thing: **an adopted
 * directory is never deleted.** DataGripe may remove a checkout it made
 * and nothing else, and the control says which case this is rather than
 * offering a checkbox that quietly does nothing.
 */

export function GitDatasourceRepo(props: {
	connection: ConnectionMetadata;
	panel: IDockviewPanelProps;
}) {
	const ref = props.connection.id;
	const [repo, setRepo] = useState<GitDatasource | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [deleteCheckout, setDeleteCheckout] = useState(false);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		wsClient
			.request<GitDatasource>("git.datasource.reload", { connectionRef: ref })
			.then(setRepo)
			.catch((cause: unknown) =>
				setError(
					cause instanceof Error ? cause.message : "Could not read the repo",
				),
			);
	}, [ref]);

	const remove = async () => {
		setBusy(true);
		setError(null);
		try {
			await wsClient.request("git.datasource.remove", {
				connectionRef: ref,
				deleteCheckout: deleteCheckout && repo?.managedClone === true,
				idempotencyKey: crypto.randomUUID(),
			});
			await useConnectionsStore.getState().load();
			props.panel.api.close();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not remove it");
			setBusy(false);
		}
	};

	return (
		<div className="dg-form-section">
			<span className="dg-form-section-title">repository</span>
			{error !== null && <p className="dg-test-failed">{error}</p>}
			{repo === null ? (
				<p className="dg-form-hint dg-rail-dim">Reading…</p>
			) : (
				<>
					<dl className="dg-repo-facts">
						<dt>checkout</dt>
						<dd>
							<code>{repo.repoPath}</code>
						</dd>
						<dt>remote</dt>
						<dd>
							{repo.remoteUrl === null ? (
								<span className="dg-rail-dim">
									adopted — DataGripe did not clone this
								</span>
							) : (
								<code>{repo.remoteUrl}</code>
							)}
						</dd>
						<dt>sync dir</dt>
						<dd>
							{repo.syncPath === null ? (
								<span className="dg-rail-dim">
									no <code>.datagripe/sync.yaml</code> yet
								</span>
							) : (
								<code>{repo.syncPath}</code>
							)}
						</dd>
					</dl>
					{/* Listed and not connectable beats hidden: somebody who just
						    cloned the repo needs to be told which variable to set. */}
					{repo.unavailable !== null && (
						<p className="dg-test-failed">{repo.unavailable}</p>
					)}
					<div className="dg-field-inline">
						<button
							type="button"
							className="dg-btn"
							onClick={() => {
								setRepo(null);
								void wsClient
									.request<GitDatasource>("git.datasource.reload", {
										connectionRef: ref,
									})
									.then(async (next) => {
										setRepo(next);
										await useConnectionsStore.getState().load();
									})
									.catch(() => setError("Could not re-read the config"));
							}}
						>
							re-read config
						</button>
						{confirming ? (
							<>
								{repo.managedClone && (
									<label className="dg-field-inline">
										<input
											type="checkbox"
											checked={deleteCheckout}
											onChange={(event) =>
												setDeleteCheckout(event.target.checked)
											}
										/>
										<span>delete the checkout too</span>
									</label>
								)}
								<button
									type="button"
									className="dg-btn dg-btn-danger"
									disabled={busy}
									onClick={() => void remove()}
								>
									{busy ? "removing…" : "remove datasource"}
								</button>
								<button
									type="button"
									className="dg-btn"
									onClick={() => setConfirming(false)}
								>
									cancel
								</button>
							</>
						) : (
							<button
								type="button"
								className="dg-btn"
								onClick={() => setConfirming(true)}
							>
								remove…
							</button>
						)}
					</div>
					{confirming && !repo.managedClone && (
						<p className="dg-form-hint">
							The directory on disk stays where it is — DataGripe did not create
							it, so it does not get to delete it.
						</p>
					)}
				</>
			)}
		</div>
	);
}
