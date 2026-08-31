import {
	type DockviewApi,
	DockviewReact,
	type DockviewReadyEvent,
	type SerializedDockview,
} from "dockview-react";
import { useEffect, useState } from "react";
import { wsClient } from "../api/ws";
import { ConnectionDialog } from "../components/ConnectionDialog";
import { DocumentSidebar } from "../components/DocumentSidebar";
import { EditorTab } from "../components/EditorTab";
import { Explorer } from "../components/Explorer";
import { ResultsPanel } from "../components/ResultsPanel";
import { WorkspaceWatermark } from "../components/WorkspaceWatermark";
import { EditorView } from "../editor/EditorView";
import { db, LOCAL_LAYOUT_ID } from "../persistence/db";
import { createDebouncer } from "../persistence/debounce";
import { parseLayout, sanitizeLayout } from "../persistence/layout";
import { draftDebouncer, useDocumentsStore } from "../stores/documents";
import {
	useConnectionsStore,
	useExecutionsStore,
	useExplorerStore,
} from "../stores/runtime";
import { useViewsStore } from "../stores/views";
import {
	closeEditorPanels,
	openEditorPanel,
	panelDocumentId,
} from "./editorPanels";
import { registerResultsOpener } from "./resultsPanel";

const LAYOUT_SAVE_DELAY_MS = 500;

const layoutDebouncer = createDebouncer();

// Hydration runs once per app lifetime, shared across StrictMode remounts.
let hydratePromise: Promise<void> | undefined;
function ensureHydrated(): Promise<void> {
	hydratePromise ??= useDocumentsStore.getState().hydrate();
	return hydratePromise;
}

const components = { editor: EditorView, results: ResultsPanel };

function persistLayout(api: DockviewApi): void {
	void db.layouts.put({
		id: LOCAL_LAYOUT_ID,
		json: api.toJSON(),
		updatedAt: new Date().toISOString(),
	});
}

async function restoreLayout(api: DockviewApi): Promise<void> {
	const row = await db.layouts.get(LOCAL_LAYOUT_ID);
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
	const hydrated = useDocumentsStore((state) => state.hydrated);
	const activeDocumentId = useViewsStore((state) =>
		state.activeViewId !== null
			? state.views[state.activeViewId]?.documentId
			: undefined,
	);
	const activeDirty = useDocumentsStore((state) =>
		activeDocumentId === undefined
			? false
			: (state.documents[activeDocumentId]?.dirty ?? false),
	);

	useEffect(() => {
		void ensureHydrated();
	}, []);

	// Workspace socket: connects once; every (re)open reloads connection
	// metadata and drops cached explorer trees.
	useEffect(() => {
		wsClient.connect();
		const offOpen = wsClient.onOpen(() => {
			useExplorerStore.getState().reset();
			void useConnectionsStore.getState().load();
		});
		const offEvent = wsClient.onEvent((event) => {
			useExecutionsStore.getState().handleEvent(event);
		});
		return () => {
			offOpen();
			offEvent();
		};
	}, []);

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
				position: { direction: "below" },
			});
		});

		setDockApi(api);
		void ensureHydrated().then(async () => {
			await restoreLayout(api);
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
		});
	};

	const newQuery = () => {
		if (dockApi === null) {
			return;
		}
		const doc = useDocumentsStore.getState().createDocument();
		openEditorPanel(dockApi, doc);
	};

	return (
		<div className="dg-workspace">
			<header className="dg-header">
				<span className="dg-brand">DataGripe</span>
				<button type="button" onClick={newQuery} disabled={dockApi === null}>
					New query
				</button>
				<button
					type="button"
					onClick={saveActiveDocument}
					disabled={!activeDirty}
					title="Save (Ctrl+S)"
				>
					Save
				</button>
			</header>
			<div className="dg-body">
				<aside className="dg-sidebar">
					<Explorer />
					<DocumentSidebar
						onOpen={(documentId) => {
							const doc = useDocumentsStore.getState().documents[documentId];
							if (dockApi !== null && doc !== undefined) {
								openEditorPanel(dockApi, doc);
							}
						}}
						onDiscard={(documentId) => {
							if (dockApi !== null) {
								closeEditorPanels(dockApi, documentId);
							}
							void useDocumentsStore.getState().discardDocument(documentId);
						}}
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
			<ConnectionDialog />
		</div>
	);
}
