import type { ConnectionMetadata } from "@datagripe/contracts";
import { useState } from "react";
import { wsClient } from "../api/ws";
import { useConnectionsStore } from "../stores/runtime";

/**
 * Adding a datasource from a repository (docs/spec/git-datasources.md
 * "Adding one").
 *
 * Two ways, one form: clone a URL into DataGripe's repos directory, or
 * adopt a checkout that already exists on the server's disk. Both end in
 * the same place — `.datagripe/config.yaml` read out of a work tree
 * root — and a repository without one is refused with the path it looked
 * in, rather than adopted as an empty datasource nobody can use.
 */

export interface GitDatasourceAddProps {
	onAdded?: (connection: ConnectionMetadata) => void;
}

export function GitDatasourceAdd(props: GitDatasourceAddProps) {
	const [mode, setMode] = useState<"clone" | "adopt">("clone");
	const [url, setUrl] = useState("");
	const [branch, setBranch] = useState("");
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const add = async () => {
		setBusy(true);
		setError(null);
		try {
			const created = await wsClient.request<ConnectionMetadata>(
				"git.datasource.add",
				mode === "clone"
					? {
							mode: "clone",
							url: url.trim(),
							...(branch.trim() === "" ? {} : { branch: branch.trim() }),
							idempotencyKey: crypto.randomUUID(),
						}
					: {
							mode: "adopt",
							path: path.trim(),
							idempotencyKey: crypto.randomUUID(),
						},
			);
			await useConnectionsStore.getState().load();
			props.onAdded?.(created);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not add that repository",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="dg-form-section">
			<span className="dg-form-section-title">from a repository</span>
			<p className="dg-form-hint">
				The repository defines the datasource: its{" "}
				<code>.datagripe/config.yaml</code> says which database this is, which
				directories are worth showing in the left bar, and how it should look.
			</p>

			<fieldset className="dg-eng" aria-label="How to add it">
				<button
					type="button"
					aria-pressed={mode === "clone"}
					onClick={() => setMode("clone")}
				>
					clone a URL
				</button>
				<button
					type="button"
					aria-pressed={mode === "adopt"}
					onClick={() => setMode("adopt")}
				>
					use a checkout on this host
				</button>
			</fieldset>

			{mode === "clone" ? (
				<div className="dg-fgrid">
					<label className="dg-field">
						<span>Repository URL</span>
						<input
							value={url}
							placeholder="https://github.com/you/wallet.git"
							onChange={(event) => setUrl(event.target.value)}
						/>
					</label>
					<label className="dg-field">
						<span>Branch (optional)</span>
						<input
							value={branch}
							placeholder="main"
							onChange={(event) => setBranch(event.target.value)}
						/>
					</label>
				</div>
			) : (
				<label className="dg-field dg-field-path">
					<span>Work tree root</span>
					<input
						value={path}
						placeholder="/home/you/repos/wallet"
						onChange={(event) => setPath(event.target.value)}
					/>
				</label>
			)}

			<p className="dg-form-hint">
				{mode === "clone" ? (
					<>
						Cloned with your ambient git configuration. DataGripe never asks for
						credentials and never stores them: if the clone needs one it fails
						with git's own message.
					</>
				) : (
					<>
						The repository root itself, not a directory inside it — DataGripe
						writes <code>.datagripe/</code> there. Nothing is deleted when you
						remove the datasource later.
					</>
				)}
			</p>

			{error !== null && <p className="dg-test-failed">{error}</p>}

			<button
				type="button"
				className="dg-btn dg-btn-primary"
				disabled={
					busy || (mode === "clone" ? url.trim() === "" : path.trim() === "")
				}
				onClick={() => void add()}
			>
				{busy ? (mode === "clone" ? "cloning…" : "reading…") : "add datasource"}
			</button>
		</div>
	);
}
