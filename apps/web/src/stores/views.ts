import { create } from "zustand";

/**
 * View store — a read model of Dockview's panel inventory for React
 * consumers (sidebar open-state, save-command routing). Dockview remains
 * the source of truth; the workspace feeds this store from
 * onDidAddPanel / onDidRemovePanel / onDidActivePanelChange.
 */

export type ViewInfo = {
	documentId: string;
};

export type ViewsState = {
	views: Record<string, ViewInfo>;
	activeViewId: string | null;
	registerView: (viewId: string, documentId: string) => void;
	unregisterView: (viewId: string) => void;
	setActiveView: (viewId: string | null) => void;
};

export const useViewsStore = create<ViewsState>()((set, get) => ({
	views: {},
	activeViewId: null,

	registerView(viewId, documentId) {
		set({ views: { ...get().views, [viewId]: { documentId } } });
	},

	unregisterView(viewId) {
		const { [viewId]: _removed, ...views } = get().views;
		set({
			views,
			activeViewId: get().activeViewId === viewId ? null : get().activeViewId,
		});
	},

	setActiveView(viewId) {
		set({ activeViewId: viewId });
	},
}));
