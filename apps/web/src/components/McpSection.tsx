import { useEffect, useState } from "react";
import { useMcpStore } from "../stores/mcp";
import { useSessionStore } from "../stores/session";
import { Toggle } from "./Toggle";

/**
 * The mcp section (docs/spec/mcp.md "The panel").
 *
 * Collapsed by default and owner-only. What it has to make plain, in
 * this order: whether anything is listening, what mode it is in — and
 * that the mode is a ceiling rather than a grant, because a datasource
 * marked `read only` stays read-only however this is set.
 */

/** How long "copied" stays on a button before it goes back to itself. */
const COPIED_MS = 1200;

function relative(iso: string | null): string {
	if (iso === null) {
		return "never used";
	}
	const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
	if (seconds < 60) {
		return "used just now";
	}
	if (seconds < 3600) {
		return `used ${Math.round(seconds / 60)}m ago`;
	}
	if (seconds < 86_400) {
		return `used ${Math.round(seconds / 3600)}h ago`;
	}
	return `used ${Math.round(seconds / 86_400)}d ago`;
}

export function McpSection() {
	const state = useMcpStore((store) => store.state);
	const loading = useMcpStore((store) => store.loading);
	const busy = useMcpStore((store) => store.busy);
	const error = useMcpStore((store) => store.error);
	const revealed = useMcpStore((store) => store.revealed);
	const project = useSessionStore((store) => store.currentWorkspace);
	const [copied, setCopied] = useState<string | null>(null);
	const [name, setName] = useState("");

	// The section only mounts when it is expanded, so this is also the
	// answer to "nothing reads the disk while it is collapsed".
	useEffect(() => {
		void useMcpStore.getState().load();
	}, []);

	const copy = (key: string, text: string) => {
		void navigator.clipboard?.writeText(text).then(() => {
			setCopied(key);
			setTimeout(
				() => setCopied((current) => (current === key ? null : current)),
				COPIED_MS,
			);
		});
	};

	if (state === null) {
		return (
			<p className="dg-sidebar-empty">
				{loading ? "Loading…" : (error ?? "Nothing to show yet.")}
			</p>
		);
	}

	/**
	 * The snippet a client wants. The token is only in it at creation
	 * time — after that there is a placeholder, because a value that was
	 * never stored cannot be shown twice.
	 */
	const clientConfig = JSON.stringify(
		{
			mcpServers: {
				[`datagripe-${(project?.name ?? "project").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`]:
					{
						type: "http",
						url: state.url,
						headers: {
							Authorization: `Bearer ${revealed?.value ?? "<your token>"}`,
						},
					},
			},
		},
		null,
		2,
	);

	const readOnlyDatasources = state.datasources.filter(
		(entry) => entry.readOnly,
	);

	return (
		<div className="dg-mcp">
			<Toggle
				on={state.enabled}
				title="mcp server"
				description={
					state.enabled
						? "An agent with a token can read this project and query its datasources."
						: "Nothing is listening for this project."
				}
				disabled={busy}
				onChange={(on) =>
					void useMcpStore
						.getState()
						.setSettings({ enabled: on, mode: state.mode })
				}
			/>

			{state.enabled && (
				<>
					<div className="dg-mcp-mode">
						<fieldset className="dg-seg" aria-label="Access">
							<button
								type="button"
								aria-pressed={state.mode === "read-only"}
								disabled={busy}
								onClick={() =>
									void useMcpStore
										.getState()
										.setSettings({ enabled: true, mode: "read-only" })
								}
							>
								read only
							</button>
							<button
								type="button"
								aria-pressed={state.mode === "read-write"}
								disabled={busy}
								onClick={() =>
									void useMcpStore
										.getState()
										.setSettings({ enabled: true, mode: "read-write" })
								}
							>
								read/write
							</button>
						</fieldset>
						<p className="dg-mcp-note">
							{state.mode === "read-only"
								? "Writes are refused before they reach the database, and every query runs in a transaction that is rolled back."
								: "Every query an agent runs commits."}
						</p>
						{/* The ceiling, named. Flipping this switch does not lift a
							  datasource's own read-only setting, and finding that out
							  from a failed query is a worse way to learn it. */}
						{state.mode === "read-write" && readOnlyDatasources.length > 0 && (
							<p className="dg-mcp-note dg-mcp-ceiling">
								Still read-only, by their own setting:{" "}
								{readOnlyDatasources.map((entry) => entry.name).join(", ")}.
							</p>
						)}
					</div>

					<div className="dg-mcp-url">
						<code>{state.url}</code>
						<div className="dg-repo-buttons">
							<button
								type="button"
								className="dg-doc-new"
								onClick={() => copy("url", state.url)}
							>
								{copied === "url" ? "copied" : "copy url"}
							</button>
							<button
								type="button"
								className="dg-doc-new"
								onClick={() => copy("config", clientConfig)}
							>
								{copied === "config" ? "copied" : "copy client config"}
							</button>
						</div>
					</div>

					{revealed !== null && (
						<div className="dg-mcp-revealed">
							<p>
								<b>{revealed.name}</b> — copy it now. This is the only time it
								is shown; DataGripe kept a hash, not the token.
							</p>
							<code>{revealed.value}</code>
							<div className="dg-repo-buttons">
								<button
									type="button"
									className="dg-doc-new"
									onClick={() => copy("token", revealed.value)}
								>
									{copied === "token" ? "copied" : "copy token"}
								</button>
								<button
									type="button"
									className="dg-doc-new"
									onClick={() => useMcpStore.getState().dismissRevealed()}
								>
									done
								</button>
							</div>
						</div>
					)}

					<ul className="dg-mcp-tokens">
						{state.tokens.map((token) => (
							<li key={token.id}>
								<span className="dg-mcp-token-name">{token.name}</span>
								<span className="dg-mcp-token-meta">
									{relative(token.lastUsedAt)}
								</span>
								<button
									type="button"
									className="dg-doc-new"
									disabled={busy}
									onClick={() => {
										if (
											window.confirm(
												`Revoke "${token.name}"? Any agent using it stops working immediately.`,
											)
										) {
											void useMcpStore.getState().revokeToken(token.id);
										}
									}}
								>
									revoke
								</button>
							</li>
						))}
						{state.tokens.length === 0 && (
							<li className="dg-mcp-token-meta">
								No tokens yet — nothing can connect.
							</li>
						)}
					</ul>

					<form
						className="dg-mcp-new"
						onSubmit={(event) => {
							event.preventDefault();
							if (name.trim() === "") {
								return;
							}
							void useMcpStore
								.getState()
								.createToken(name.trim())
								.then(() => setName(""));
						}}
					>
						<input
							type="text"
							value={name}
							maxLength={60}
							placeholder="claude code on the laptop"
							aria-label="New token name"
							onChange={(event) => setName(event.target.value)}
						/>
						<button
							type="submit"
							className="dg-doc-new"
							disabled={busy || name.trim() === ""}
						>
							create token
						</button>
					</form>

					<p className="dg-mcp-status">
						{state.mode === "read-only" ? "read only" : "read/write"} ·{" "}
						{state.datasources.length}{" "}
						{state.datasources.length === 1 ? "datasource" : "datasources"} ·{" "}
						{state.fileCount} {state.fileCount === 1 ? "file" : "files"}
						{state.instructionsSource === null
							? ""
							: ` · briefing from ${state.instructionsSource}`}
					</p>
				</>
			)}

			{error !== null && <p className="dg-test-failed">{error}</p>}
		</div>
	);
}
