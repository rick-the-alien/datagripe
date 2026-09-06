import type { ConnectionMetadata } from "@datagripe/contracts";
import type { DockviewApi } from "dockview-react";

/**
 * Opener seam for the non-editor surfaces (same pattern as
 * resultsPanel.ts): the Workspace registers Dockview-aware openers;
 * callers (Explorer, breadcrumb, header, prompt) use them without
 * knowing Dockview.
 *
 * Forms (new/edit datasource, new project, project settings) are tabs,
 * not modals — they survive navigation, can sit side by side, and don't
 * trap focus (docs/brand/mocks/datasource-selector.html "New datasource
 * is a tab").
 *
 * The table view (docs/spec/table-view.md) and the object view
 * (docs/spec/object-view.md) are real. The gripes panel is still a MOCK
 * — see docs/brand/brand-system.md "Gripes".
 */

export interface ObjectTarget {
	connectionId: string;
	/** Namespace the object lives in (schema / database / attached file). */
	schema: string;
	/** Object name as shown in the tree (last path segment). */
	name: string;
	kind: "table" | "view";
}

let tableViewOpener: ((target: ObjectTarget) => void) | null = null;
let objectViewOpener: ((target: ObjectTarget, tab?: string) => void) | null =
	null;
let gripesOpener: (() => void) | null = null;
let connectionFormOpener:
	| ((connection: ConnectionMetadata | null) => void)
	| null = null;
let newProjectOpener: (() => void) | null = null;
let projectSettingsOpener: (() => void) | null = null;

function focusOrAdd(
	api: DockviewApi,
	panel: Parameters<DockviewApi["addPanel"]>[0],
): void {
	const existing = api.getPanel(panel.id ?? "");
	if (existing !== undefined) {
		existing.focus();
		return;
	}
	api.addPanel(panel);
}

export function registerViewPanelOpeners(api: DockviewApi): void {
	tableViewOpener = (target) => {
		// Two schemas can hold a `payments`; the id has to say which.
		const id = `table:${target.connectionId}/${target.schema}.${target.name}`;
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
		const id = `object:${target.connectionId}/${target.schema}.${target.name}`;
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

	connectionFormOpener = (connection) => {
		if (connection === null) {
			focusOrAdd(api, {
				id: "datasource:new",
				component: "connectionForm",
				title: "New datasource",
				params: { view: "connection" },
			});
			return;
		}
		focusOrAdd(api, {
			id: `datasource:edit:${connection.id}`,
			component: "connectionForm",
			title: `Edit ${connection.name}`,
			params: { view: "connection", connectionId: connection.id },
		});
	};
	newProjectOpener = () => {
		focusOrAdd(api, {
			id: "project:new",
			component: "newProject",
			title: "New project",
			params: { view: "newProject" },
		});
	};
	projectSettingsOpener = () => {
		focusOrAdd(api, {
			id: "project:settings",
			component: "projectSettings",
			title: "Project settings",
			params: { view: "projectSettings" },
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

/** `null` opens the create form; a connection opens it for editing. */
export function openConnectionForm(
	connection: ConnectionMetadata | null,
): void {
	connectionFormOpener?.(connection);
}

export function openNewProject(): void {
	newProjectOpener?.();
}

export function openProjectSettings(): void {
	projectSettingsOpener?.();
}

/** Connection form panel params: absent connectionId means "create". */
export function readConnectionFormParams(params: unknown): {
	connectionId: string | undefined;
} {
	if (params === null || typeof params !== "object") {
		return { connectionId: undefined };
	}
	const connectionId =
		"connectionId" in params && typeof params.connectionId === "string"
			? params.connectionId
			: undefined;
	return { connectionId };
}

/** Panel params for the table/object views, narrowed without casts. */
export interface ViewPanelParams {
	connectionId: string;
	schema: string;
	name: string;
	kind: "table" | "view";
	tab?: string | undefined;
}

function readString(params: object, key: string, fallback: string): string {
	return key in params &&
		typeof (params as Record<string, unknown>)[key] === "string"
		? ((params as Record<string, string>)[key] as string)
		: fallback;
}

export function readViewPanelParams(params: unknown): ViewPanelParams {
	if (params === null || typeof params !== "object") {
		return { connectionId: "", schema: "", name: "object", kind: "table" };
	}
	const kind =
		"kind" in params && params.kind === "view" ? "view" : ("table" as const);
	const tab =
		"tab" in params && typeof params.tab === "string" ? params.tab : undefined;
	return {
		connectionId: readString(params, "connectionId", ""),
		schema: readString(params, "schema", ""),
		name: readString(params, "name", "object"),
		kind,
		tab,
	};
}
