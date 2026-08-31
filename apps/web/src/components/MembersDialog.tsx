import type {
	WorkspaceMember,
	WorkspaceMembersResult,
} from "@datagripe/contracts";
import { useEffect, useState } from "react";
import { wsClient } from "../api/ws";
import { useSessionStore } from "../stores/session";

/** Workspace members: list for everyone; add/remove for owners. */
export function MembersDialog(props: { onClose: () => void }) {
	const role = useSessionStore((state) => state.bootstrap?.workspace?.role);
	const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
	const [email, setEmail] = useState("");
	const [role_, setRole] = useState<"editor" | "viewer">("editor");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void wsClient
			.request<WorkspaceMembersResult>("workspace.members", {})
			.then((result) => setMembers(result.members))
			.catch((err: unknown) =>
				setError(err instanceof Error ? err.message : "Load failed"),
			);
	}, []);

	const reload = () => {
		void wsClient
			.request<WorkspaceMembersResult>("workspace.members", {})
			.then((result) => setMembers(result.members))
			.catch((err: unknown) =>
				setError(err instanceof Error ? err.message : "Load failed"),
			);
	};

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				props.onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [props]);

	return (
		<div className="dg-modal-backdrop" role="presentation">
			<div className="dg-modal" role="dialog" aria-label="Workspace members">
				<div className="dg-modal-title">Workspace members</div>
				{error !== null && <p className="dg-test-failed">{error}</p>}
				{members === null ? (
					<p className="dg-modal-hint">Loading…</p>
				) : (
					<ul className="dg-member-list">
						{members.map((member) => (
							<li key={member.userId} className="dg-member-row">
								<span className="dg-member-email">{member.email}</span>
								<span className="dg-badge">{member.role}</span>
								{role === "owner" && member.role !== "owner" && (
									<button
										type="button"
										className="dg-document-delete"
										aria-label={`Remove ${member.email}`}
										onClick={() => {
											void wsClient
												.request("workspace.member.remove", {
													userId: member.userId,
												})
												.then(reload)
												.catch((err: unknown) =>
													setError(
														err instanceof Error
															? err.message
															: "Remove failed",
													),
												);
										}}
									>
										×
									</button>
								)}
							</li>
						))}
					</ul>
				)}
				{role === "owner" && (
					<form
						className="dg-member-add"
						onSubmit={(event) => {
							event.preventDefault();
							setError(null);
							void wsClient
								.request("workspace.member.add", {
									email: email.trim(),
									role: role_,
								})
								.then(() => {
									setEmail("");
									reload();
								})
								.catch((err: unknown) =>
									setError(err instanceof Error ? err.message : "Add failed"),
								);
						}}
					>
						<input
							type="email"
							placeholder="member@example.com"
							aria-label="Member email"
							value={email}
							required
							onChange={(event) => setEmail(event.target.value)}
						/>
						<select
							value={role_}
							aria-label="Member role"
							onChange={(event) =>
								setRole(event.target.value as "editor" | "viewer")
							}
						>
							<option value="editor">editor</option>
							<option value="viewer">viewer</option>
						</select>
						<button type="submit">Add</button>
					</form>
				)}
				<div className="dg-modal-actions">
					<span className="dg-modal-actions-spacer" />
					<button type="button" onClick={props.onClose}>
						Close
					</button>
				</div>
			</div>
		</div>
	);
}
