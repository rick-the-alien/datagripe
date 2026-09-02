import type {
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
import { useEffect, useRef, useState } from "react";
import { wsClient } from "../api/ws";
import { ActivityBar } from "../components/ActivityBar";
import { ConnectionDialog } from "../components/ConnectionDialog";
import { DocumentSidebar } from "../components/DocumentSidebar";
import { EditorTab } from "../components/EditorTab";
import { Explorer } from "../components/Explorer";
import { GripesPanel } from "../components/GripesPanel";
import { MembersDialog } from "../components/MembersDialog";
import { ObjectView } from "../components/ObjectView";
import { PresenceSidebar } from "../components/PresenceSidebar";
import { ProjectPrompt } from "../components/ProjectPrompt";
import { ResultsPanel } from "../components/ResultsPanel";
import { SidebarSections } from "../components/SidebarSections";
import { StatusBar } from "../components/StatusBar";
import { TableView } from "../components/TableView";
import { WorkspaceWatermark } from "../components/WorkspaceWatermark";
import { EditorView } from "../editor/EditorView";
import { db, LOCAL_LAYOUT_ID } from "../persistence/db";
import { createDebouncer } from "../persistence/debounce";
import { parseLayout, sanitizeLayout } from "../persistence/layout";
import { useDatasourceStore } from "../stores/datasource";
import { draftDebouncer, useDocumentsStore } from "../stores/documents";
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
} from "./editorPanels";
import { registerResultsOpener } from "./resultsPanel";
import { registerViewPanelOpeners } from "./viewPanels";

const LAYOUT_SAVE_DELAY_MS = 500;

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

export function Workspace() {
	const [dockApi, setDockApi] = useState<DockviewApi | null>(null);
	const dockApiRef = useRef<DockviewApi | null>(null);
	const [showMembers, setShowMembers] = useState(false);
	const sessionUser = useSessionStore((state) => state.bootstrap?.user);
	const currentWorkspace = useSessionStore((state) => state.currentWorkspace);
	const logout = useSessionStore((state) => state.logout);
	const hydrated = useDocumentsStore((state) => state.hydrated);
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
			usePresenceStore.getState().reset();
			useExecutionsStore.getState().reset();
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
				<button type="button" onClick={() => setShowMembers(true)}>
					Members
				</button>
				<span className="dg-header-meta">{sessionUser?.email}</span>
				<button type="button" onClick={() => void logout()}>
					Log out
				</button>
			</header>
			<div className="dg-body">
				<aside className="dg-sidebar">
					<div className="dg-explorer-region">
						<Explorer />
					</div>
					<SidebarSections
						sections={[
							{
								id: "files",
								title: "Workspace files",
								weight: 1,
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
								weight: 1,
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
								weight: 1,
								body: <PresenceSidebar />,
							},
						]}
					/>
				</aside>
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
			<ConnectionDialog />
			{showMembers && <MembersDialog onClose={() => setShowMembers(false)} />}
		</div>
	);
}
