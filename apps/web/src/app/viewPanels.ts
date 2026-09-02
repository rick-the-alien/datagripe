import type { DockviewApi } from "dockview-react";

/**
 * Opener seam for the non-editor surfaces (same pattern as
 * resultsPanel.ts): the Workspace registers Dockview-aware openers;
 * the Explorer calls them without knowing Dockview.
 *
 * Table view, object view and the gripes panel are currently MOCK
 * implementations — see docs/brand/brand-system.md "Table view and
 * object view", "Danger zone" and "Gripes".
 */

export interface ObjectTarget {
	connectionId: string;
	/** Object name as shown in the tree (last path segment). */
	name: string;
	kind: "table" | "view";
}

let tableViewOpener: ((target: ObjectTarget) => void) | null = null;
let objectViewOpener: ((target: ObjectTarget, tab?: string) => void) | null =
	null;
let gripesOpener: (() => void) | null = null;

export function registerViewPanelOpeners(api: DockviewApi): void {
	tableViewOpener = (target) => {
		const id = `table:${target.connectionId}/${target.name}`;
		const existing = api.getPanel(id);
		if (existing !== undefined) {
			existing.focus();
			return;
		}
		api.addPanel({
			id,
			component: "tableView",
			title: target.name,
			params: { ...target, view: "table" },
		});
	};
	objectViewOpener = (target, tab) => {
		const id = `object:${target.connectionId}/${target.name}`;
		const existing = api.getPanel(id);
		if (existing !== undefined) {
			existing.focus();
			if (tab !== undefined) {
				existing.api.updateParameters({ ...target, tab, view: "object" });
			}
			return;
		}
		api.addPanel({
			id,
			component: "objectView",
			title: `${target.name} · structure`,
			params: { ...target, tab, view: "object" },
		});
	};
	gripesOpener = () => {
		const existing = api.getPanel("gripes");
		if (existing !== undefined) {
			existing.focus();
			return;
		}
		api.addPanel({
			id: "gripes",
			component: "gripes",
			title: "Gripes",
			position: { direction: "below" },
		});
	};
}

export function openTableView(target: ObjectTarget): void {
	tableViewOpener?.(target);
}

export function openObjectView(target: ObjectTarget, tab?: string): void {
	objectViewOpener?.(target, tab);
}

export function openGripesPanel(): void {
	gripesOpener?.();
}

/** Panel params for the mock table/object views, narrowed without casts. */
export interface ViewPanelParams {
	name: string;
	kind: "table" | "view";
	tab?: string | undefined;
}

export function readViewPanelParams(params: unknown): ViewPanelParams {
	if (params === null || typeof params !== "object") {
		return { name: "object", kind: "table" };
	}
	const name =
		"name" in params && typeof params.name === "string"
			? params.name
			: "object";
	const kind =
		"kind" in params && params.kind === "view" ? "view" : ("table" as const);
	const tab =
		"tab" in params && typeof params.tab === "string" ? params.tab : undefined;
	return { name, kind, tab };
}
