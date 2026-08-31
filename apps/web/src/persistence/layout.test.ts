import { describe, expect, test } from "bun:test";
import {
	EDITOR_PANEL_COMPONENT,
	type GridObject,
	parseLayout,
	type SerializedLayout,
	sanitizeLayout,
} from "./layout";

const DOC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GONE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function editorPanel(id: string, documentId: string) {
	return {
		id,
		contentComponent: EDITOR_PANEL_COMPONENT,
		params: { documentId },
		title: "query.sql",
	};
}

function layout(): SerializedLayout {
	return {
		grid: {
			root: {
				type: "branch",
				data: [
					{
						type: "leaf",
						data: {
							id: "group-1",
							views: ["view-1", "view-2"],
							activeView: "view-1",
						},
						size: 400,
					},
					{
						type: "leaf",
						data: { id: "group-2", views: ["view-3"] },
						size: 400,
					},
				],
			},
			width: 800,
			height: 600,
			orientation: "HORIZONTAL",
		},
		panels: {
			"view-1": editorPanel("view-1", DOC_A),
			"view-2": editorPanel("view-2", DOC_B),
			"view-3": editorPanel("view-3", GONE),
		},
		activeGroup: "group-2",
	};
}

describe("parseLayout", () => {
	test("accepts a Dockview-serialized layout", () => {
		expect(parseLayout(layout())).toBeDefined();
	});

	test("rejects garbage so callers fall back to an empty workspace", () => {
		expect(parseLayout("not a layout")).toBeUndefined();
		expect(parseLayout({ grid: {} })).toBeUndefined();
		expect(parseLayout(null)).toBeUndefined();
	});
});

describe("sanitizeLayout", () => {
	test("keeps every panel when all documents exist", () => {
		const known = new Set([DOC_A, DOC_B, GONE]);
		const result = sanitizeLayout(layout(), known);
		expect(Object.keys(result?.panels ?? {})).toHaveLength(3);
		expect(result?.activeGroup).toBe("group-2");
	});

	test("drops panels whose document was deleted and prunes empty groups", () => {
		const known = new Set([DOC_A, DOC_B]);
		const result = sanitizeLayout(layout(), known);
		expect(result).toBeDefined();
		expect(Object.keys(result?.panels ?? {}).sort()).toEqual([
			"view-1",
			"view-2",
		]);

		// Cast to named const: schema types root as unknown, GridObject is the
		// validated shape exported by layout.ts.
		const root = result?.grid.root as GridObject | undefined;
		if (root?.type !== "branch") {
			throw new Error("expected branch root");
		}
		// group-2 held only view-3 (deleted document) → pruned.
		expect(root.data).toHaveLength(1);
		const leaf = root.data[0];
		if (leaf?.type !== "leaf") {
			throw new Error("expected leaf");
		}
		expect(leaf.data.id).toBe("group-1");
		// activeGroup pointed at the pruned group → cleared.
		expect(result?.activeGroup).toBeUndefined();
	});

	test("filters dropped panels out of a surviving group's views", () => {
		const known = new Set([DOC_B]);
		const result = sanitizeLayout(layout(), known);
		expect(result).toBeDefined();
		const root = result?.grid.root as GridObject | undefined;
		if (root?.type !== "branch") {
			throw new Error("expected branch root");
		}
		expect(root.data).toHaveLength(1);
		const leaf = root.data[0];
		if (leaf?.type !== "leaf") {
			throw new Error("expected leaf");
		}
		expect(leaf.data.views).toEqual(["view-2"]);
		// activeView pointed at the dropped panel → cleared.
		expect(leaf.data.activeView).toBeUndefined();
	});

	test("returns undefined when nothing salvageable remains", () => {
		expect(sanitizeLayout(layout(), new Set())).toBeUndefined();
	});

	test("keeps non-editor panels regardless of document binding", () => {
		const withTool = layout();
		withTool.panels["tool-1"] = { id: "tool-1", contentComponent: "explorer" };
		// Cast to named const: same unknown→GridObject boundary as above.
		const root = withTool.grid.root as GridObject;
		if (root.type !== "branch" || root.data[1]?.type !== "leaf") {
			throw new Error("unexpected fixture shape");
		}
		root.data[1].data.views.push("tool-1");
		const result = sanitizeLayout(withTool, new Set([DOC_A, DOC_B]));
		expect(result?.panels["tool-1"]).toBeDefined();
	});
});
