import type {
	WorkspaceMember,
	WorkspaceMembersResult,
} from "@datagripe/contracts";
import { useEffect, useState } from "react";
import { wsClient } from "../api/ws";
import {
	PROJECT_CLASS_COLORS,
	PROJECT_CLASSES,
	useBrandingStore,
} from "../stores/branding";
import { useSessionStore } from "../stores/session";
import { MockBadge } from "./MockBadge";

/**
 * Project settings tab (header cog): rename, the mock class picker, and
 * member management — the surfaces that used to be the prompt menu's
 * class select and the Members modal. Rename and member edits are
 * owner-only; everyone else sees the current values.
 */
export function ProjectSettingsPanel() {
	const currentWorkspace = useSessionStore((state) => state.currentWorkspace);
	const authDisabled = useSessionStore(
		(state) => state.bootstrap?.authDisabled ?? false,
	);
	const projectClass = useBrandingStore((state) =>
		state.classFor(currentWorkspace?.id ?? null),
	);
	const setClass = useBrandingStore((state) => state.setClass);

	const [name, setName] = useState(currentWorkspace?.name ?? "");
	const [renameBusy, setRenameBusy] = useState(false);
	const [renameError, setRenameError] = useState<string | null>(null);

	// The workspace can arrive after the panel (layout restore on boot).
	useEffect(() => {
		if (currentWorkspace !== null && name === "") {
			setName(currentWorkspace.name);
		}
	}, [currentWorkspace, name]);

	if (currentWorkspace === null) {
		return (
			<div className="dg-form dg-scroll">
				<div className="dg-form-body">
					<h3 className="dg-form-title">Project settings</h3>
					<p className="dg-form-lead">No project loaded yet.</p>
				</div>
			</div>
		);
	}

	const isOwner = currentWorkspace.role === "owner";
	const canRename =
		isOwner && name.trim().length > 0 && name.trim() !== currentWorkspace.name;

	const rename = async () => {
		setRenameBusy(true);
		setRenameError(null);
		try {
			await useSessionStore.getState().renameWorkspace(name.trim());
		} catch (err) {
			setRenameError(err instanceof Error ? err.message : "Rename failed");
		} finally {
			setRenameBusy(false);
		}
	};

	return (
		<div className="dg-form dg-scroll">
			<div className="dg-form-body">
				<h3 className="dg-form-title">Project settings</h3>
				<p className="dg-form-lead">
					<b>{currentWorkspace.name}</b> · your role: {currentWorkspace.role}
				</p>

				<div className="dg-fgrid">
					<label className="dg-field">
						<span>Name</span>
						<input
							value={name}
							disabled={!isOwner}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
				</div>
				{!isOwner && (
					<p className="dg-form-note">Only the project owner can rename it.</p>
				)}
				{renameError !== null && (
					<p className="dg-test-failed">{renameError}</p>
				)}
				{isOwner && (
					<div className="dg-frow">
						<button
							type="button"
							className="dg-btn dg-btn-pri"
							disabled={!canRename || renameBusy}
							onClick={() => void rename()}
						>
							{renameBusy ? "saving…" : "rename"}
						</button>
					</div>
				)}

				<fieldset className="dg-field dg-form-section">
					<legend>
						Class <MockBadge />
					</legend>
					<div className="dg-cls">
						{PROJECT_CLASSES.map((value) => (
							<button
								key={value}
								type="button"
								style={
									{ "--cc": PROJECT_CLASS_COLORS[value] } as React.CSSProperties
								}
								aria-pressed={projectClass === value}
								onClick={() => setClass(currentWorkspace.id, value)}
							>
								<span className="dg-cls-sw" />
								{value}
							</button>
						))}
					</div>
					<p className="dg-form-note">
						Decides the project accent colour in the prompt and the safety
						colour for destructive actions.
					</p>
				</fieldset>

				{!authDisabled && <MembersSection isOwner={isOwner} />}
			</div>
		</div>
	);
}

/** Workspace members: list for everyone; add/remove for owners. */
function MembersSection(props: { isOwner: boolean }) {
	const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"editor" | "viewer">("editor");
	const [error, setError] = useState<string | null>(null);

	const reload = () => {
		void wsClient
			.request<WorkspaceMembersResult>("workspace.members", {})
			.then((result) => setMembers(result.members))
			.catch((err: unknown) =>
				setError(err instanceof Error ? err.message : "Load failed"),
			);
	};

	useEffect(reload, []);

	return (
		<div className="dg-form-section">
			<span className="dg-form-section-title">Members</span>
			{error !== null && <p className="dg-test-failed">{error}</p>}
			{members === null ? (
				<p className="dg-form-note">Loading…</p>
			) : (
				<ul className="dg-member-list">
					{members.map((member) => (
						<li key={member.userId} className="dg-member-row">
							<span className="dg-member-email">{member.email}</span>
							<span className="dg-badge">{member.role}</span>
							{props.isOwner && member.role !== "owner" && (
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
													err instanceof Error ? err.message : "Remove failed",
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
			{props.isOwner && (
				<form
					className="dg-member-add"
					onSubmit={(event) => {
						event.preventDefault();
						setError(null);
						void wsClient
							.request("workspace.member.add", {
								email: email.trim(),
								role,
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
						value={role}
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
		</div>
	);
}
