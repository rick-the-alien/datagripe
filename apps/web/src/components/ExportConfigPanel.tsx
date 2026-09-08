import type { ExportConfigResult } from "@datagripe/contracts";
import { useState } from "react";
import { wsClient } from "../api/ws";

/**
 * Generating a `.datagripe/` set from a datasource that already exists
 * (docs/spec/git-datasources.md "Exporting a config from an existing
 * datasource").
 *
 * Preview first, always: half the time the destination is a repository
 * on a different machine and what is wanted is the text, not a write.
 *
 * This does not convert the datasource. It stays managed or predefined;
 * what you get is a directory you can commit, and adding it back as a
 * git datasource is a separate, deliberate act.
 */

export interface ExportConfigPanelProps {
	connectionRef: string;
	/** Seeds the target field — usually the datasource's export path. */
	suggestedDir?: string;
}

export function ExportConfigPanel(props: ExportConfigPanelProps) {
	const [targetDir, setTargetDir] = useState(props.suggestedDir ?? "");
	const [result, setResult] = useState<ExportConfigResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);

	const run = async (dryRun: boolean, overwrite: boolean) => {
		setBusy(true);
		setError(null);
		try {
			setResult(
				await wsClient.request<ExportConfigResult>("datasource.export-config", {
					connectionRef: props.connectionRef,
					targetDir,
					dryRun,
					overwrite,
					idempotencyKey: crypto.randomUUID(),
				}),
			);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not generate the config",
			);
		} finally {
			setBusy(false);
		}
	};

	const clashes = (result?.files ?? []).filter((file) => file.exists);

	return (
		<div className="dg-form-section">
			<span className="dg-form-section-title">export config</span>
			<p className="dg-form-hint">
				Write this datasource's settings as a <code>.datagripe/</code> directory
				you can commit. A teammate who clones that repository gets the same
				connection, the same sidebar sections and the same domains.
			</p>
			<div className="dg-field dg-field-path">
				<label htmlFor="dg-export-config-dir">
					<span>Target directory</span>
				</label>
				<input
					id="dg-export-config-dir"
					value={targetDir}
					placeholder="/home/you/repo"
					onChange={(event) => {
						setTargetDir(event.target.value);
						setResult(null);
					}}
				/>
			</div>
			<div className="dg-field-inline">
				<button
					type="button"
					className="dg-btn"
					disabled={busy || targetDir.trim() === ""}
					onClick={() => void run(true, false)}
				>
					{busy ? "generating…" : "preview"}
				</button>
				{result !== null && !result.written && (
					<button
						type="button"
						className="dg-btn"
						disabled={busy}
						onClick={() => void run(false, clashes.length > 0)}
					>
						{clashes.length > 0
							? `overwrite ${clashes.length} file${clashes.length === 1 ? "" : "s"}`
							: "write it"}
					</button>
				)}
			</div>

			{error !== null && <p className="dg-test-failed">{error}</p>}

			{result !== null && (
				<div className="dg-export-config">
					{/* The password is never written. Saying so here beats a
						    placeholder in the file that looks like a setting. */}
					<p className="dg-form-hint">
						No password is written. The generated config names{" "}
						<code>{result.passwordEnv}</code>; set that on the server that will
						use it.
					</p>
					{result.outsideRepo.length > 0 && (
						<p className="dg-form-hint dg-test-failed">
							{result.outsideRepo.length} path
							{result.outsideRepo.length === 1 ? "" : "s"} sit outside this
							repository and cannot be relative:{" "}
							{result.outsideRepo.map((entry) => entry.name).join(", ")}. They
							are written as comments, not dropped.
						</p>
					)}
					{result.written && <p className="dg-test-ok">Written.</p>}
					{result.files.map((file) => (
						<div key={file.path} className="dg-export-config-file">
							<div className="dg-export-config-head">
								<code>{file.path}</code>
								{file.exists && !result.written && (
									<span className="dg-test-failed">already there</span>
								)}
								<button
									type="button"
									className="dg-btn"
									onClick={() => {
										void navigator.clipboard
											?.writeText(file.content)
											.then(() => setCopied(file.path));
									}}
								>
									{copied === file.path ? "copied" : "copy"}
								</button>
							</div>
							<pre>{file.content}</pre>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
