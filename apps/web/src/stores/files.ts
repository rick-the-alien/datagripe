import type { FileEntry, FileListResult } from "@datagripe/contracts";
import { create } from "zustand";
import { wsClient } from "../api/ws";

/**
 * Directory listings for the datasource path sections
 * (docs/spec/datasource-paths.md).
 *
 * Loaded per directory rather than per tree: a checkout is deep and
 * mostly irrelevant, and the one thing worse than a slow expand is a
 * sidebar that stalls on open because something walked `node_modules`.
 *
 * Expansion lives here rather than in the component so collapsing the
 * section — which unmounts it — does not forget where you were.
 */

/** `pathId:subPath`; the empty subPath is the configured root itself. */
export function dirKey(pathId: string, subPath: string): string {
	return `${pathId}:${subPath}`;
}

export type FilesState = {
	entries: Record<string, FileEntry[]>;
	loading: Record<string, boolean>;
	/** Why a directory would not list — shown in place of its children. */
	errors: Record<string, string>;
	expanded: Record<string, boolean>;
	load: (
		connectionRef: string,
		pathId: string,
		subPath: string,
		refresh?: boolean,
	) => Promise<void>;
	toggle: (connectionRef: string, pathId: string, subPath: string) => void;
	/** Drop one path's cached listings (its directory moved, or a refresh). */
	invalidate: (pathId: string) => void;
	reset: () => void;
};

export const useFilesStore = create<FilesState>()((set, get) => ({
	entries: {},
	loading: {},
	errors: {},
	expanded: {},

	async load(connectionRef, pathId, subPath, refresh = false) {
		const key = dirKey(pathId, subPath);
		if (get().loading[key] || (!refresh && get().entries[key] !== undefined)) {
			return;
		}
		set({ loading: { ...get().loading, [key]: true } });
		try {
			const result = await wsClient.request<FileListResult>("file.list", {
				connectionRef,
				pathId,
				subPath,
			});
			const { [key]: _cleared, ...errors } = get().errors;
			set({
				entries: { ...get().entries, [key]: result.entries },
				errors,
			});
		} catch (cause) {
			set({
				errors: {
					...get().errors,
					[key]: cause instanceof Error ? cause.message : "Could not read it",
				},
			});
		} finally {
			const { [key]: _done, ...loading } = get().loading;
			set({ loading });
		}
	},

	toggle(connectionRef, pathId, subPath) {
		const key = dirKey(pathId, subPath);
		const open = get().expanded[key] !== true;
		set({ expanded: { ...get().expanded, [key]: open } });
		if (open) {
			void get().load(connectionRef, pathId, subPath);
		}
	},

	invalidate(pathId) {
		const prefix = `${pathId}:`;
		const keep = <T>(record: Record<string, T>): Record<string, T> =>
			Object.fromEntries(
				Object.entries(record).filter(([key]) => !key.startsWith(prefix)),
			);
		set({
			entries: keep(get().entries),
			errors: keep(get().errors),
			loading: keep(get().loading),
		});
	},

	reset: () => set({ entries: {}, loading: {}, errors: {}, expanded: {} }),
}));
