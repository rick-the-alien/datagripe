import { z } from "zod";

/**
 * Layout restore helpers. Dockview owns the `SerializedDockview` shape; we
 * validate only what we depend on (panel records, `params.documentId`, and
 * group membership via each leaf's `views` list) and pass everything else
 * through untouched. A corrupt layout must never block editing — callers
 * fall back to an empty workspace on `undefined`.
 */

const serializedPanelSchema = z
	.object({
		id: z.string().min(1),
		contentComponent: z.string().min(1).optional(),
		params: z.object({ documentId: z.uuid() }).loose().optional(),
	})
	.loose();

const serializedLeafSchema = z
	.object({
		type: z.literal("leaf"),
		data: z
			.object({
				id: z.string(),
				views: z.array(z.string()),
				activeView: z.string().optional(),
			})
			.loose(),
		size: z.number().optional(),
		visible: z.boolean().optional(),
	})
	.loose();

const serializedGridObjectSchema: z.ZodType<unknown> = z.lazy(() =>
	z.union([
		serializedLeafSchema,
		z
			.object({
				type: z.literal("branch"),
				data: z.array(serializedGridObjectSchema),
				size: z.number().optional(),
				visible: z.boolean().optional(),
			})
			.loose(),
	]),
);

export const serializedLayoutSchema = z
	.object({
		grid: z
			.object({
				root: serializedGridObjectSchema,
				width: z.number(),
				height: z.number(),
				orientation: z.enum(["HORIZONTAL", "VERTICAL"]),
			})
			.loose(),
		panels: z.record(z.string(), serializedPanelSchema),
		activeGroup: z.string().optional(),
	})
	.loose();

export type SerializedLayout = z.infer<typeof serializedLayoutSchema>;
export type SerializedLeaf = z.infer<typeof serializedLeafSchema>;
export type GridObject =
	| SerializedLeaf
	| { type: "branch"; data: GridObject[]; size?: number; visible?: boolean };

/** Editor panels carry their document binding in params. */
export const EDITOR_PANEL_COMPONENT = "editor";

export function parseLayout(raw: unknown): SerializedLayout | undefined {
	const result = serializedLayoutSchema.safeParse(raw);
	return result.success ? result.data : undefined;
}

/**
 * Drop panels that reference deleted documents, filter dropped panels out
 * of their groups' `views` lists, and prune groups left empty. Dockview
 * cannot restore a panel whose document is gone, and an empty group
 * renders as a dead split. Returns `undefined` when nothing salvageable
 * remains.
 */
export function sanitizeLayout(
	layout: SerializedLayout,
	knownDocumentIds: ReadonlySet<string>,
): SerializedLayout | undefined {
	const panels: SerializedLayout["panels"] = {};
	for (const [id, panel] of Object.entries(layout.panels)) {
		if (panel.contentComponent !== EDITOR_PANEL_COMPONENT) {
			panels[id] = panel;
			continue;
		}
		const documentId = panel.params?.documentId;
		if (documentId !== undefined && knownDocumentIds.has(documentId)) {
			panels[id] = panel;
		}
	}

	const surviving = new Set(Object.keys(panels));
	const root = pruneGridObject(layout.grid.root as GridObject, surviving);
	if (root === undefined) {
		return undefined;
	}

	const groupIds = new Set<string>();
	collectGroupIds(root, groupIds);
	const activeGroup =
		layout.activeGroup !== undefined && groupIds.has(layout.activeGroup)
			? layout.activeGroup
			: undefined;

	return {
		...layout,
		grid: { ...layout.grid, root },
		panels,
		activeGroup,
	};
}

function pruneGridObject(
	node: GridObject,
	surviving: ReadonlySet<string>,
): GridObject | undefined {
	if (node.type === "leaf") {
		const views = node.data.views.filter((view) => surviving.has(view));
		if (views.length === 0) {
			return undefined;
		}
		const activeView =
			node.data.activeView !== undefined && surviving.has(node.data.activeView)
				? node.data.activeView
				: undefined;
		return {
			...node,
			data: {
				...node.data,
				views,
				activeView,
			},
		};
	}

	const children = node.data
		.map((child) => pruneGridObject(child, surviving))
		.filter((child): child is GridObject => child !== undefined);
	return children.length === 0 ? undefined : { ...node, data: children };
}

function collectGroupIds(node: GridObject, into: Set<string>): void {
	if (node.type === "leaf") {
		into.add(node.data.id);
		return;
	}
	for (const child of node.data) {
		collectGroupIds(child, into);
	}
}
