import type {
	DatasourcePath,
	DocumentChangedPayload,
	PresenceUser,
	ViewFollowedPayload,
	ViewStatePayload,
} from "@datagripe/contracts";
import {
	type DockviewApi,
	DockviewReact,
	type DockviewReadyEvent,
	type SerializedDockview,
} from "dockview-react";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { wsClient } from "../api/ws";
import { AccessPanel } from "../components/AccessPanel";
import { ActivityBar } from "../components/ActivityBar";
import { ConnectionForm } from "../components/ConnectionForm";
import { DocumentSidebar } from "../components/DocumentSidebar";
import { DomainManager } from "../components/DomainManager";
import { EditorTab } from "../components/EditorTab";
import { Explorer } from "../components/Explorer";
import { GripesPanel } from "../components/GripesPanel";
import { NewProjectForm } from "../components/NewProjectForm";
import { ObjectView } from "../components/ObjectView";
import { PathTree } from "../components/PathTree";
import { PresenceSidebar } from "../components/PresenceSidebar";
import { ProjectPrompt } from "../components/ProjectPrompt";
import { ProjectSettingsPanel } from "../components/ProjectSettingsPanel";
import { RepoSection } from "../components/RepoSection";
import { ResultsPanel } from "../components/ResultsPanel";
import { SidebarSections } from "../components/SidebarSections";
import { StatusBar } from "../components/StatusBar";
import { SyncPanel } from "../components/SyncPanel";
import { TableView } from "../components/TableView";
import { WorkspaceWatermark } from "../components/WorkspaceWatermark";
import { EditorView } from "../editor/EditorView";
import { db, LOCAL_LAYOUT_ID } from "../persistence/db";
import { createDebouncer } from "../persistence/debounce";
import { parseLayout, sanitizeLayout } from "../persistence/layout";
import { useDatasourceStore } from "../stores/datasource";
import { draftDebouncer, useDocumentsStore } from "../stores/documents";
import { useFilesStore } from "../stores/files";
import { useRepoStore } from "../stores/git";
import { useGripesStore } from "../stores/gripes";
import { usePresenceStore } from "../stores/presence";
import {
	useConnectionsStore,
	useExecutionsStore,
	useExplorerStore,
} from "../stores/runtime";
import { useSessionStore } from "../stores/session";
import { useViewsStore } from "../stores/views";
import {
	closeEditorPanels,
	openEditorPanel,
	panelDocumentId,
	registerEditorPanelApi,
} from "./editorPanels";
import { registerResultsOpener } from "./resultsPanel";
import { openProjectSettings, registerViewPanelOpeners } from "./viewPanels";

const LAYOUT_SAVE_DELAY_MS = 500;

/** Sidebar width is a user preference, not layout — it applies to every
 * workspace, so it lives in localStorage rather than the dock layout. */
const SIDEBAR_WIDTH_KEY = "dg.sidebar.width";
const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 520;

function clampSidebarWidth(width: number): number {
	return Math.min(
		SIDEBAR_MAX_WIDTH,
		Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
	);
}

function readSidebarWidth(): number {
	try {
		const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
		const parsed = raw === null ? Number.NaN : Number(raw);
		return Number.isFinite(parsed)
			? clampSidebarWidth(parsed)
			: SIDEBAR_DEFAULT_WIDTH;
	} catch {
		return SIDEBAR_DEFAULT_WIDTH;
	}
}

const layoutDebouncer = createDebouncer();

/** Layouts are per workspace (dock arrangements differ per project);
 * scratchpads appear in every workspace's layout. */
function layoutKey(workspaceId: string | null): string {
	return workspaceId === null ? LOCAL_LAYOUT_ID : `ws:${workspaceId}`;
}

// Hydration runs once per workspace, shared across StrictMode remounts.
const hydratePromises = new Map<string | null, Promise<void>>();
function ensureHydrated(workspaceId: string | null): Promise<void> {
	let promise = hydratePromises.get(workspaceId);
	if (promise === undefined) {
		promise = useDocumentsStore.getState().hydrate(workspaceId);
		hydratePromises.set(workspaceId, promise);
	}
	return promise;
}

const components = {
	editor: EditorView,
	results: ResultsPanel,
	tableView: TableView,
	objectView: ObjectView,
	gripes: GripesPanel,
	connectionForm: ConnectionForm,
	newProject: NewProjectForm,
	projectSettings: ProjectSettingsPanel,
	domainManager: DomainManager,
	syncPanel: SyncPanel,
	accessPanel: AccessPanel,
};

function persistLayout(api: DockviewApi): void {
	void db.layouts.put({
		id: layoutKey(useSessionStore.getState().currentWorkspaceId),
		json: api.toJSON(),
		updatedAt: new Date().toISOString(),
	});
}

async function restoreLayout(
	api: DockviewApi,
	workspaceId: string | null,
): Promise<void> {
	let row = await db.layouts.get(layoutKey(workspaceId));
	// One-time fallback: layouts saved before per-workspace keys.
	if (row === undefined && workspaceId !== null) {
		row = await db.layouts.get(LOCAL_LAYOUT_ID);
	}
	if (row === undefined) {
		return;
	}
	const parsed = parseLayout(row.json);
	if (parsed === undefined) {
		return;
	}
	const knownDocumentIds = new Set(
		Object.keys(useDocumentsStore.getState().documents),
	);
	const sanitized = sanitizeLayout(parsed, knownDocumentIds);
	if (sanitized === undefined) {
		return;
	}
	// Cast to named const: our schema validated the subset of
	// SerializedDockview we depend on; the shapes are structurally
	// compatible but inference cannot unify them.
	const serialized = sanitized as SerializedDockview;
	api.fromJSON(serialized);
}

/** Route the save shortcut to the last editor view's document. */
function saveActiveDocument(): void {
	const { lastEditorViewId, views } = useViewsStore.getState();
	const documentId =
		lastEditorViewId !== null ? views[lastEditorViewId]?.documentId : undefined;
	if (documentId !== undefined) {
		void useDocumentsStore.getState().saveDocument(documentId);
	}
}

/** Stable empty array: a fresh `[]` per render would loop the selector. */
const EMPTY_PATHS: DatasourcePath[] = [];

export function Workspace() {
	const [dockApi, setDockApi] = useState<DockviewApi | null>(null);
	const dockApiRef = useRef<DockviewApi | null>(null);
	const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);

	const persistSidebarWidth = (width: number) => {
		setSidebarWidth(width);
		try {
			localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
		} catch {
			// Storage blocked — the width just stops persisting.
		}
	};

	const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = sidebarWidth;
		let lastWidth = startWidth;
		const onMove = (move: PointerEvent) => {
			lastWidth = clampSidebarWidth(startWidth + move.clientX - startX);
			setSidebarWidth(lastWidth);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			persistSidebarWidth(lastWidth);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	const sessionUser = useSessionStore((state) => state.bootstrap?.user);
	const authDisabled = useSessionStore(
		(state) => state.bootstrap?.authDisabled ?? false,
	);
	const currentWorkspace = useSessionStore((state) => state.currentWorkspace);
	const logout = useSessionStore((state) => state.logout);
	const hydrated = useDocumentsStore((state) => state.hydrated);
	// The path sections belong to the datasource the tree is scoped to:
	// switching datasource swaps them, the way it swaps the tree.
	const activeConnectionId = useDatasourceStore(
		(state) => state.activeConnectionId,
	);
	const datasourcePaths = useConnectionsStore(
		(state) =>
			state.connections.find((entry) => entry.id === activeConnectionId)
				?.paths ?? EMPTY_PATHS,
	);
	// A repository-backed datasource brings a repository section with it
	// (docs/spec/git-datasources.md).
	const isGitDatasource = useConnectionsStore(
		(state) =>
			state.connections.find((entry) => entry.id === activeConnectionId)
				?.source === "git",
	);
	const followingUserId = usePresenceStore((state) => state.followingUserId);
	const followedBy = usePresenceStore((state) => state.followedBy);
	const presenceUsers = usePresenceStore((state) => state.users);
	const followingEmail = presenceUsers.find(
		(u) => u.userId === followingUserId,
	)?.email;

	const currentWorkspaceId = useSessionStore(
		(state) => state.currentWorkspaceId,
	);

	useEffect(() => {
		void ensureHydrated(currentWorkspaceId);
	}, [currentWorkspaceId]);

	// Workspace socket: connects once; every (re)open confirms the bound
	// workspace, reloads its metadata, syncs its shared documents, and —
	// on workspace switch — replaces the layout.
	useEffect(() => {
		wsClient.connect(currentWorkspaceId);
		void useSessionStore.getState().loadWorkspaces();
		const offOpen = wsClient.onOpen(() => {
			useExplorerStore.getState().reset();
			useDatasourceStore.getState().reset();
			// Directory listings are per workspace *and* per host: a
			// reconnect may be to a different server with different paths.
			useFilesStore.getState().reset();
			// Status is per host as much as per workspace: a reconnect may be
			// to a different server with different checkouts.
			useRepoStore.getState().reset();
			usePresenceStore.getState().reset();
			useExecutionsStore.getState().reset();
			// Dismissals are workspace-wide, so they rescope with everything
			// else. Findings are re-derived from the documents that follow.
			useGripesStore.getState().reset();
			void useGripesStore.getState().loadDismissals();
			void useConnectionsStore
				.getState()
				.load()
				.then((result) => {
					useSessionStore.getState().confirmWorkspace(result.workspace);
					void useDocumentsStore
						.getState()
						.switchWorkspace(result.workspace.id)
						.then(() =>
							useDocumentsStore
								.getState()
								.syncFromServer(result.documents, result.workspace.id),
						)
						.then(() => {
							const api = dockApiRef.current;
							if (api !== null) {
								// Workspace switch: replace the layout wholesale.
								api.clear();
								void restoreLayout(api, result.workspace.id);
							}
						});
				});
		});
		const offEvent = wsClient.onEvent((event) => {
			if (event.topic === "presence.update") {
				const payload = event.payload as { users: PresenceUser[] };
				usePresenceStore.getState().setUsers(payload.users);
				return;
			}
			if (event.topic === "view.state") {
				usePresenceStore
					.getState()
					.setRemoteView(event.payload as ViewStatePayload);
				return;
			}
			if (event.topic === "view.followed") {
				const payload = event.payload as ViewFollowedPayload;
				usePresenceStore
					.getState()
					.setFollowedBy(payload.followerUserId, payload.following);
				return;
			}
			if (event.topic === "document.changed") {
				void useDocumentsStore
					.getState()
					.applyServerChange(event.payload as DocumentChangedPayload);
				return;
			}
			// A datasource was added or removed by somebody in this project
			// (docs/spec/git-datasources.md). The sidebar's sections come off
			// the connection list, so a stale one leaves them behind.
			if (event.topic === "connections.changed") {
				void useConnectionsStore.getState().load();
				return;
			}
			// A pull moved HEAD. Files on disk changed under whatever is
			// open, so the listings are dropped and every file-backed
			// document from that datasource re-runs the open check — which
			// is the existing three-case rule, not a new one
			// (docs/spec/datasource-paths.md "When the file moves
			// underneath").
			if (event.topic === "repo.changed") {
				const payload = event.payload as {
					connectionRef: string;
					changedPaths: string[];
					configChanged: boolean;
				};
				useFilesStore.getState().reset();
				// Status is per host as much as per workspace: a reconnect may be
				// to a different server with different checkouts.
				useRepoStore.getState().reset();
				if (payload.configChanged) {
					void useConnectionsStore.getState().load();
				}
				void useDocumentsStore
					.getState()
					.resyncFilesFrom(payload.connectionRef);
				return;
			}
			useExecutionsStore.getState().handleEvent(event);
		});
		return () => {
			offOpen();
			offEvent();
		};
	}, [currentWorkspaceId]);

	// Publish the focused document for presence (server dedups unchanged).
	const lastEditorDocumentId = useViewsStore((state) =>
		state.lastEditorViewId !== null
			? state.views[state.lastEditorViewId]?.documentId
			: undefined,
	);
	useEffect(() => {
		wsClient
			.request("document.focus", {
				documentId: lastEditorDocumentId ?? null,
			})
			.catch(() => {});
	}, [lastEditorDocumentId]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key === "s") {
				event.preventDefault();
				event.stopPropagation();
				saveActiveDocument();
				return;
			}
			// Capture phase is required: Monaco's own Ctrl+Enter binding
			// (insertLineAfter) otherwise consumes the event first.
			if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
				const lastEditorViewId = useViewsStore.getState().lastEditorViewId;
				if (lastEditorViewId === null) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				void useExecutionsStore
					.getState()
					.run(lastEditorViewId, event.shiftKey ? "document" : "auto");
			}
		};
		const onBeforeUnload = () => {
			draftDebouncer.flush();
			layoutDebouncer.flush();
		};
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("beforeunload", onBeforeUnload);
		};
	}, []);

	const onReady = (event: DockviewReadyEvent) => {
		const api = event.api;
		const { registerView, unregisterView, setActiveView } =
			useViewsStore.getState();

		api.onDidLayoutChange(() => {
			layoutDebouncer.schedule(
				LOCAL_LAYOUT_ID,
				() => persistLayout(api),
				LAYOUT_SAVE_DELAY_MS,
			);
		});
		api.onDidAddPanel((panel) => {
			const documentId = panelDocumentId(panel.params);
			if (documentId !== undefined) {
				registerView(panel.id, documentId);
			}
		});
		api.onDidRemovePanel((panel) => {
			unregisterView(panel.id);
		});
		api.onDidActivePanelChange((panel) => {
			setActiveView(panel?.id ?? null);
		});

		registerResultsOpener(() => {
			const existing = api.getPanel("results");
			if (existing !== undefined) {
				existing.focus();
				return;
			}
			api.addPanel({
				id: "results",
				component: "results",
				title: "Results",
				params: { view: "results" },
				position: { direction: "below" },
			});
		});
		registerViewPanelOpeners(api);
		// Lets a gripe row bring its document's tab to the front, not just
		// scroll an editor that may be hidden behind another tab.
		registerEditorPanelApi(api);

		setDockApi(api);
		dockApiRef.current = api;
		void ensureHydrated(useSessionStore.getState().currentWorkspaceId).then(
			async () => {
				await restoreLayout(api, useSessionStore.getState().currentWorkspaceId);
				// onDidAddPanel does not reliably fire for panels restored via
				// fromJSON; sync the view store from Dockview (source of truth).
				const { registerView, setActiveView } = useViewsStore.getState();
				for (const panel of api.panels) {
					const documentId = panelDocumentId(panel.params);
					if (documentId !== undefined) {
						registerView(panel.id, documentId);
					}
				}
				setActiveView(api.activePanel?.id ?? null);
			},
		);
	};

	const newDocument = (shared: boolean) => {
		if (dockApi === null) {
			return;
		}
		const doc = useDocumentsStore.getState().createDocument(undefined, shared);
		openEditorPanel(dockApi, doc);
	};

	return (
		<div className="dg-workspace">
			<ActivityBar />
			<header className="dg-header">
				<ProjectPrompt />
				<span className="dg-modal-actions-spacer" />
				{followingUserId !== null && (
					<span className="dg-follow-chip">
						Following {followingEmail ?? followingUserId}
						<button
							type="button"
							className="dg-follow-detach"
							aria-label="Stop following"
							onClick={() => usePresenceStore.getState().unfollow()}
						>
							×
						</button>
					</span>
				)}
				{followedBy.length > 0 && (
					<span className="dg-header-meta">
						Followed by {followedBy.length}
					</span>
				)}
				{currentWorkspace !== null && (
					<span className="dg-header-meta">{currentWorkspace.role}</span>
				)}
				{currentWorkspace !== null && (
					<button
						type="button"
						className="dg-header-cog"
						title="Project settings"
						aria-label="Project settings"
						onClick={() => openProjectSettings()}
					>
						⚙
					</button>
				)}
				<span className="dg-header-meta">{sessionUser?.email}</span>
				{!authDisabled && (
					<button type="button" onClick={() => void logout()}>
						Log out
					</button>
				)}
			</header>
			<div className="dg-body">
				<aside className="dg-sidebar" style={{ width: sidebarWidth }}>
					<div className="dg-explorer-region">
						<Explorer />
					</div>
					<SidebarSections
						sections={[
							// The repository, then its own files, then DataGripe's
							// (docs/spec/git-datasources.md, docs/spec/datasource-paths.md).
							...(isGitDatasource && activeConnectionId !== null
								? [
										{
											id: `repo:${activeConnectionId}`,
											title: "repository",
											body: <RepoSection connectionRef={activeConnectionId} />,
										},
									]
								: []),
							...datasourcePaths.map((path) => ({
								id: `path:${path.id}`,
								title: path.name,
								body: (
									<PathTree
										connectionRef={activeConnectionId ?? ""}
										path={path}
										onOpen={(doc) => {
											if (dockApi !== null) {
												openEditorPanel(dockApi, doc);
											}
										}}
									/>
								),
							})),
							{
								id: "files",
								title: "Workspace files",
								body: (
									<DocumentSidebar
										kind="shared"
										onCreate={newDocument}
										onOpen={(documentId) => {
											const doc =
												useDocumentsStore.getState().documents[documentId];
											if (dockApi !== null && doc !== undefined) {
												openEditorPanel(dockApi, doc);
											}
										}}
										onDiscard={(documentId) => {
											if (dockApi !== null) {
												closeEditorPanels(dockApi, documentId);
											}
											void useDocumentsStore
												.getState()
												.discardDocument(documentId);
										}}
									/>
								),
							},
							{
								id: "scratch",
								title: "Scratchpads (local)",
								body: (
									<DocumentSidebar
										kind="scratch"
										onCreate={newDocument}
										onOpen={(documentId) => {
											const doc =
												useDocumentsStore.getState().documents[documentId];
											if (dockApi !== null && doc !== undefined) {
												openEditorPanel(dockApi, doc);
											}
										}}
										onDiscard={(documentId) => {
											if (dockApi !== null) {
												closeEditorPanels(dockApi, documentId);
											}
											void useDocumentsStore
												.getState()
												.discardDocument(documentId);
										}}
									/>
								),
							},
							{
								id: "online",
								title: "Online",
								body: <PresenceSidebar />,
							},
						]}
					/>
				</aside>
				<hr
					className="dg-sidebar-resizer"
					aria-orientation="vertical"
					aria-label="Resize sidebar"
					aria-valuenow={sidebarWidth}
					aria-valuemin={SIDEBAR_MIN_WIDTH}
					aria-valuemax={SIDEBAR_MAX_WIDTH}
					tabIndex={0}
					onPointerDown={startSidebarResize}
					onKeyDown={(event) => {
						if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
							event.preventDefault();
							persistSidebarWidth(
								clampSidebarWidth(
									sidebarWidth + (event.key === "ArrowRight" ? 16 : -16),
								),
							);
						}
					}}
				/>
				<div className="dg-dock-container">
					{hydrated ? (
						<DockviewReact
							className="dockview-theme-abyss dg-dock"
							components={components}
							defaultTabComponent={EditorTab}
							watermarkComponent={WorkspaceWatermark}
							onReady={onReady}
						/>
					) : (
						<div className="dg-loading">Loading workspace…</div>
					)}
				</div>
			</div>
			<StatusBar />
		</div>
	);
}
