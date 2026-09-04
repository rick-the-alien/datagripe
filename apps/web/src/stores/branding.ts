import { create } from "zustand";

/**
 * MOCK — branding placeholders (docs/brand/brand-system.md).
 *
 * The brand spec gives every project a colour class (production /
 * staging / local / analytics) and a per-project attitude level for the
 * gripes engine. Neither exists in the server model yet, so both are
 * stored locally per workspace id until the real fields land.
 */

export type ProjectClass = "production" | "staging" | "local" | "analytics";

export const PROJECT_CLASS_COLORS: Record<ProjectClass, string> = {
	production: "var(--dg-proj-production)",
	staging: "var(--dg-proj-staging)",
	local: "var(--dg-proj-local)",
	analytics: "var(--dg-proj-analytics)",
};

export const PROJECT_CLASSES: ProjectClass[] = [
	"local",
	"staging",
	"production",
	"analytics",
];

export type AttitudeLevel = "notice" | "warning" | "fatal" | "panic";

const CLASS_STORAGE_KEY = "dg.mock.workspaceClass";
const ATTITUDE_STORAGE_KEY = "dg.mock.attitude";

function readMap<T extends string>(key: string): Record<string, T> {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) {
			return {};
		}
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, T>)
			: {};
	} catch {
		return {};
	}
}

function writeMap(key: string, value: Record<string, string>): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage full or blocked — the mock degrades to defaults.
	}
}

export type BrandingState = {
	/** workspace id → colour class (default local). */
	classes: Record<string, ProjectClass>;
	/** workspace id → attitude level (default warning). */
	attitudes: Record<string, AttitudeLevel>;
	classFor: (workspaceId: string | null) => ProjectClass;
	setClass: (workspaceId: string, projectClass: ProjectClass) => void;
	attitudeFor: (workspaceId: string | null) => AttitudeLevel;
	setAttitude: (workspaceId: string, level: AttitudeLevel) => void;
};

export const useBrandingStore = create<BrandingState>()((set, get) => ({
	classes: readMap<ProjectClass>(CLASS_STORAGE_KEY),
	attitudes: readMap<AttitudeLevel>(ATTITUDE_STORAGE_KEY),
	classFor: (workspaceId) =>
		workspaceId === null ? "local" : (get().classes[workspaceId] ?? "local"),
	setClass: (workspaceId, projectClass) => {
		const classes = { ...get().classes, [workspaceId]: projectClass };
		set({ classes });
		writeMap(CLASS_STORAGE_KEY, classes);
	},
	attitudeFor: (workspaceId) =>
		workspaceId === null
			? "warning"
			: (get().attitudes[workspaceId] ?? "warning"),
	setAttitude: (workspaceId, level) => {
		const attitudes = { ...get().attitudes, [workspaceId]: level };
		set({ attitudes });
		writeMap(ATTITUDE_STORAGE_KEY, attitudes);
	},
}));
