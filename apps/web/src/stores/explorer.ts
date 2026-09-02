import type {
	RedisGetResult,
	SchemaNode,
	SchemaPathSegment,
} from "@datagripe/contracts";
import { create } from "zustand";
import type { WsRequestFn } from "../api/ws";

/**
 * Schema explorer tree state. Deliberately a plain store rather than a
 * query cache: refresh must propagate `refresh: true` into the request
 * payload for exactly the expanded paths, which query caches cannot
 * express. Children stay cached until refresh or socket reconnect.
 */

export type ChildrenState =
	| { status: "loading" }
	| { status: "loaded"; nodes: SchemaNode[] }
	| { status: "error"; message: string };

export function nodeKey(
	connectionId: string,
	path: SchemaPathSegment[],
): string {
	const suffix = path
		.map((segment) => `${segment.kind}:${segment.name}`)
		.join("/");
	return `${connectionId}/${suffix}`;
}

export type KeyValueState =
	| { status: "loading" }
	| { status: "loaded"; value: RedisGetResult }
	| { status: "error"; message: string };

export type ExplorerState = {
	children: Record<string, ChildrenState>;
	/** Key → path; presence means expanded. The path travels along so
	 * refresh can re-request without reverse-parsing the key. */
	expanded: Record<string, { connectionId: string; path: SchemaPathSegment[] }>;
	/** Fetched keyspace values keyed by node key. */
	keyValues: Record<string, KeyValueState>;
	toggle: (connectionId: string, path: SchemaPathSegment[]) => Promise<void>;
	/** Load children without expanding — the field popover peeks. */
	ensure: (connectionId: string, path: SchemaPathSegment[]) => Promise<void>;
	toggleKeyValue: (
		connectionId: string,
		path: SchemaPathSegment[],
		key: string,
	) => Promise<void>;
	/** Re-request every expanded path plus the given tree root (the
	 * breadcrumb's datasource+namespace root is never "expanded", it is
	 * the base the tree hangs from). */
	refresh: (
		connectionId: string,
		rootPath?: SchemaPathSegment[] | null,
	) => Promise<void>;
	reset: () => void;
};

export function createExplorerStore(request: WsRequestFn) {
	return create<ExplorerState>()((set, get) => {
		async function fetchChildren(
			connectionId: string,
			path: SchemaPathSegment[],
			refresh: boolean,
		): Promise<void> {
			const key = nodeKey(connectionId, path);
			set({
				children: { ...get().children, [key]: { status: "loading" } },
			});
			try {
				const result = await request<{ nodes: SchemaNode[] }>(
					"schema.children",
					{ connectionId, path, refresh },
				);
				set({
					children: {
						...get().children,
						[key]: { status: "loaded", nodes: result.nodes },
					},
				});
			} catch (error) {
				set({
					children: {
						...get().children,
						[key]: {
							status: "error",
							message: error instanceof Error ? error.message : "Load failed",
						},
					},
				});
			}
		}

		return {
			children: {},
			expanded: {},
			keyValues: {},

			async toggle(connectionId, path) {
				const key = nodeKey(connectionId, path);
				if (get().expanded[key] !== undefined) {
					const { [key]: _collapsed, ...expanded } = get().expanded;
					set({ expanded });
					return;
				}
				set({
					expanded: {
						...get().expanded,
						[key]: { connectionId, path },
					},
				});
				if (get().children[key] === undefined) {
					await fetchChildren(connectionId, path, false);
				}
			},

			async ensure(connectionId, path) {
				const key = nodeKey(connectionId, path);
				if (get().children[key] === undefined) {
					await fetchChildren(connectionId, path, false);
				}
			},

			async toggleKeyValue(connectionId, path, keyName) {
				const key = nodeKey(connectionId, path);
				if (get().expanded[key] !== undefined) {
					const { [key]: _collapsed, ...expanded } = get().expanded;
					set({ expanded });
					return;
				}
				set({
					expanded: {
						...get().expanded,
						[key]: { connectionId, path },
					},
				});
				set({
					keyValues: { ...get().keyValues, [key]: { status: "loading" } },
				});
				try {
					const result = await request<RedisGetResult>("redis.get", {
						connectionId,
						key: keyName,
					});
					set({
						keyValues: {
							...get().keyValues,
							[key]: { status: "loaded", value: result },
						},
					});
				} catch (error) {
					set({
						keyValues: {
							...get().keyValues,
							[key]: {
								status: "error",
								message: error instanceof Error ? error.message : "Load failed",
							},
						},
					});
				}
			},

			async refresh(connectionId, rootPath) {
				const targets = new Map<string, SchemaPathSegment[]>();
				targets.set(nodeKey(connectionId, []), []);
				if (rootPath != null) {
					targets.set(nodeKey(connectionId, rootPath), rootPath);
				}
				for (const entry of Object.values(get().expanded)) {
					if (entry.connectionId === connectionId) {
						targets.set(nodeKey(entry.connectionId, entry.path), entry.path);
					}
				}
				// Drop cached children for this connection so re-expanding a
				// collapsed node also refetches.
				const children = Object.fromEntries(
					Object.entries(get().children).filter(
						([key]) => !key.startsWith(`${connectionId}/`),
					),
				);
				set({ children });
				await Promise.all(
					[...targets.values()].map((path) =>
						fetchChildren(connectionId, path, true),
					),
				);
			},

			reset() {
				set({ children: {}, expanded: {}, keyValues: {} });
			},
		};
	});
}

export type ExplorerStore = ReturnType<typeof createExplorerStore>;
