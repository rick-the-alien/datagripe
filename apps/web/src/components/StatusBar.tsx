import { openGripesPanel } from "../app/viewPanels";
import { PROJECT_CLASS_COLORS, useBrandingStore } from "../stores/branding";
import { NAMESPACE_LABELS, useDatasourceStore } from "../stores/datasource";
import { useConnectionsStore } from "../stores/runtime";
import { useSessionStore } from "../stores/session";
import { MockBadge } from "./MockBadge";

/**
 * Status bar (brand-system.md "Projects and the prompt", mocks/
 * datasource-selector.html): the connection indicator names the active
 * datasource + namespace and carries the project class accent, so
 * production reads as permanent magenta in peripheral vision.
 *
 * MOCK — health ("connected" vs degraded) is not tracked yet, so the dot
 * only encodes the project class; the gripes button opens the mock panel.
 */
export function StatusBar() {
	const currentWorkspace = useSessionStore((state) => state.currentWorkspace);
	const connections = useConnectionsStore((state) => state.connections);
	const activeConnectionId = useDatasourceStore(
		(state) => state.activeConnectionId,
	);
	const namespace = useDatasourceStore((state) =>
		activeConnectionId === null
			? undefined
			: state.namespaceByConnection[activeConnectionId],
	);
	const projectClass = useBrandingStore((state) =>
		state.classFor(currentWorkspace?.id ?? null),
	);

	const active = connections.find(
		(connection) => connection.id === activeConnectionId,
	);

	return (
		<footer className="dg-statusbar">
			<span className="dg-statusbar-item">
				<span
					className="dg-status-dot"
					style={{ background: PROJECT_CLASS_COLORS[projectClass] }}
				/>
				{active !== undefined ? active.name : "no datasource"}
			</span>
			{active !== undefined && namespace !== undefined && (
				<span className="dg-statusbar-item">
					{NAMESPACE_LABELS[active.adapter]} {namespace}
				</span>
			)}
			<span className="dg-statusbar-item">
				{currentWorkspace?.name ?? "…"} · {projectClass} <MockBadge />
			</span>
			<span className="dg-statusbar-spacer" />
			<button
				type="button"
				className="dg-statusbar-button"
				onClick={() => openGripesPanel()}
			>
				no gripes
			</button>
		</footer>
	);
}
