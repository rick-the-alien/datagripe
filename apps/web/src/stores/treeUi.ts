import type { DomainTarget } from "@datagripe/contracts";
import { create } from "zustand";

/**
 * Selection state shared by both trees (docs/spec/domains.md "Sidebar").
 *
 * Its own module because the schema tree, the grouped tree and the
 * context menu all read it: a multi-selection made by filtering the
 * schema tree has to still be live when the grouped tree drags it into a
 * domain, and a store that lived inside one of those components would
 * make the other import it.
 */

/** Single-row selection plus the singleton field popover, shared across
 * the recursive tree. Opening a popover replaces whichever was open. */
export interface TreeUiState {
	selectedKey: string | null;
	/**
	 * Ctrl/Cmd-click adds to this. It is the bulk-tagging path: filter the
	 * tree, select the matches, tag once — the thing that makes tagging
	 * two hundred objects survivable (docs/spec/domains.md "Context menu").
	 */
	multiSelected: Record<string, DomainTarget>;
	popoverKey: string | null;
	select: (key: string | null) => void;
	toggleMulti: (key: string, target: DomainTarget) => void;
	clearMulti: () => void;
	openPopover: (key: string) => void;
	closePopover: () => void;
}

export const useTreeUi = create<TreeUiState>()((set, get) => ({
	selectedKey: null,
	multiSelected: {},
	popoverKey: null,
	// A plain click collapses the multi-selection: leaving it live after
	// you have obviously moved on is how a bulk action hits the wrong
	// two hundred objects.
	select: (key) => set({ selectedKey: key, multiSelected: {} }),
	toggleMulti: (key, target) => {
		const { [key]: existing, ...rest } = get().multiSelected;
		set({
			selectedKey: key,
			multiSelected: existing === undefined ? { ...rest, [key]: target } : rest,
		});
	},
	clearMulti: () => set({ multiSelected: {} }),
	openPopover: (key) => set({ popoverKey: key }),
	closePopover: () => set({ popoverKey: null }),
}));
