import { useEffect, useRef, useState } from "react";
import { useQueryBusy } from "../hooks/useQueryBusy";
import {
	PROJECT_CLASS_COLORS,
	type ProjectClass,
	useBrandingStore,
} from "../stores/branding";
import { useSessionStore } from "../stores/session";
import { MockBadge } from "./MockBadge";

const PROJECT_CLASSES: ProjectClass[] = [
	"local",
	"staging",
	"production",
	"analytics",
];

/**
 * The project switcher is a shell prompt, not a control
 * (brand-system.md "Projects and the prompt"): `>Datagripe:<project>_`.
 * Brand fixed, project name takes the class accent, cursor blinks idle
 * and goes solid while a statement runs. Click opens the switcher.
 */
export function ProjectPrompt() {
	const currentWorkspace = useSessionStore((state) => state.currentWorkspace);
	const workspaces = useSessionStore((state) => state.workspaces);
	const switchWorkspace = useSessionStore((state) => state.switchWorkspace);
	const createWorkspace = useSessionStore((state) => state.createWorkspace);
	const classFor = useBrandingStore((state) => state.classFor);
	const setClass = useBrandingStore((state) => state.setClass);
	const busy = useQueryBusy();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLSpanElement | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (event: MouseEvent) => {
			if (
				rootRef.current !== null &&
				!rootRef.current.contains(event.target as Node)
			) {
				setOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
			}
		};
		window.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const projectClass = classFor(currentWorkspace?.id ?? null);
	const accent = PROJECT_CLASS_COLORS[projectClass];
	const menuAnchor = rootRef.current?.getBoundingClientRect();

	return (
		<span ref={rootRef}>
			<button
				type="button"
				className={busy ? "dg-prompt is-busy" : "dg-prompt"}
				style={{ "--dg-project": accent } as React.CSSProperties}
				aria-label={`Current project: ${currentWorkspace?.name ?? "…"}. Open project switcher.`}
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
			>
				<span className="dg-prompt__gt">&gt;</span>
				<span className="dg-prompt__brand">
					Data<b>gripe</b>
				</span>
				<span className="dg-prompt__sep">:</span>
				<span className="dg-prompt__project">
					{currentWorkspace?.name ?? "…"}
				</span>
				<span className="dg-prompt__cursor" />
			</button>
			{open && menuAnchor !== undefined && (
				<div
					className="dg-prompt-menu"
					role="menu"
					style={{ top: menuAnchor.bottom + 6, left: menuAnchor.left }}
				>
					{workspaces.map((workspace) => {
						const workspaceClass = classFor(workspace.id);
						return (
							<button
								key={workspace.id}
								type="button"
								className="dg-prompt-item"
								role="menuitem"
								onClick={() => {
									setOpen(false);
									if (workspace.id !== currentWorkspace?.id) {
										switchWorkspace(workspace.id);
									}
								}}
							>
								<span
									className="dg-status-dot"
									style={{
										background: PROJECT_CLASS_COLORS[workspaceClass],
									}}
								/>
								{workspace.name}
								<span className="dg-prompt-item-class">{workspaceClass}</span>
							</button>
						);
					})}
					<button
						type="button"
						className="dg-prompt-item"
						role="menuitem"
						onClick={() => {
							setOpen(false);
							const name = window.prompt("Project name");
							if (name !== null && name.trim().length > 0) {
								void createWorkspace(name.trim());
							}
						}}
					>
						New project…
					</button>
					{currentWorkspace !== null && (
						<div className="dg-prompt-class-picker">
							<span>
								Class <MockBadge />
							</span>
							<select
								aria-label="Project class (mock)"
								value={projectClass}
								onChange={(event) =>
									setClass(
										currentWorkspace.id,
										event.target.value as ProjectClass,
									)
								}
							>
								{PROJECT_CLASSES.map((value) => (
									<option key={value} value={value}>
										{value}
									</option>
								))}
							</select>
						</div>
					)}
				</div>
			)}
		</span>
	);
}
