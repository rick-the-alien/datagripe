import {
	type DockviewApi,
	DockviewReact,
	type DockviewReadyEvent,
	type SerializedDockview,
} from "dockview-react";
import { useEffect, useState } from "react";
import { DocumentSidebar } from "../components/DocumentSidebar";
import { EditorTab } from "../components/EditorTab";
import { WorkspaceWatermark } from "../components/WorkspaceWatermark";
import { EditorView } from "../editor/EditorView";
import { db, LOCAL_LAYOUT_ID } from "../persistence/db";
import { createDebouncer } from "../persistence/debounce";
import { parseLayout, sanitizeLayout } from "../persistence/layout";
import { draftDebouncer, useDocumentsStore } from "../stores/documents";
import { useViewsStore } from "../stores/views";
import {
	closeEditorPanels,
	openEditorPanel,
	panelDocumentId,
} from "./editorPanels";

const LAYOUT_SAVE_DELAY_MS = 500;

const layoutDebouncer = createDebouncer();

// Hydration runs once per app lifetime, shared across StrictMode remounts.
let hydratePromise: Promise<void> | undefined;
function ensureHydrated(): Promise<void> {
	hydratePromise ??= useDocumentsStore.getState().hydrate();
	return hydratePromise;
}

const components = { editor: EditorView };

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

/** Route the save shortcut to the active view's document. */
function saveActiveDocument(): void {
	const { activeViewId, views } = useViewsStore.getState();
	const documentId =
		activeViewId !== null ? views[activeViewId]?.documentId : undefined;
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

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key === "s") {
				event.preventDefault();
				saveActiveDocument();
			}
		};
		const onBeforeUnload = () => {
			draftDebouncer.flush();
			layoutDebouncer.flush();
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
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

		setDockApi(api);
		void ensureHydrated().then(() => restoreLayout(api));
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
		</div>
	);
}
