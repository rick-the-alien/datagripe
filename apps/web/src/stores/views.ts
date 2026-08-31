import { create } from "zustand";

/**
 * View store — a read model of Dockview's panel inventory for React
 * consumers (sidebar open-state, save/run-command routing). Dockview
 * remains the source of truth; the workspace feeds this store from
 * onDidAddPanel / onDidRemovePanel / onDidActivePanelChange and a sync
 * after layout restore.
 *
 * `lastEditorViewId` tracks the most recent EDITOR view regardless of
 * which panel is active, so run/save commands and the results panel keep
 * working while a non-editor panel (Results) has focus.
 */

export type ViewInfo = {
	documentId: string;
};

export type ViewsState = {
	views: Record<string, ViewInfo>;
	activeViewId: string | null;
	lastEditorViewId: string | null;
	registerView: (viewId: string, documentId: string) => void;
	unregisterView: (viewId: string) => void;
	setActiveView: (viewId: string | null) => void;
};

export const useViewsStore = create<ViewsState>()((set, get) => ({
	views: {},
	activeViewId: null,
	lastEditorViewId: null,

	registerView(viewId, documentId) {
		set({ views: { ...get().views, [viewId]: { documentId } } });
	},

	unregisterView(viewId) {
		const { [viewId]: _removed, ...views } = get().views;
		set({
			views,
			activeViewId: get().activeViewId === viewId ? null : get().activeViewId,
			lastEditorViewId:
				get().lastEditorViewId === viewId ? null : get().lastEditorViewId,
		});
	},

	setActiveView(viewId) {
		const isEditor = viewId !== null && get().views[viewId] !== undefined;
		set({
			activeViewId: viewId,
			lastEditorViewId: isEditor ? viewId : get().lastEditorViewId,
		});
	},
}));
