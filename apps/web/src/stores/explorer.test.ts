import { describe, expect, test } from "bun:test";
import type { SchemaNode, SchemaPathSegment } from "@datagripe/contracts";
import type { ClientAction } from "@datagripe/contracts/ws";
import { createExplorerStore, nodeKey } from "./explorer";

const SCHEMAS: SchemaNode[] = [
	{ kind: "schema", name: "app", hasChildren: true },
	{ kind: "schema", name: "public", hasChildren: true },
];
const CATEGORIES: SchemaNode[] = [
	{ kind: "tables", name: "tables", hasChildren: true },
	{ kind: "views", name: "views", hasChildren: true },
];

/** Records requests and serves canned nodes per path depth. */
function createFakeRequest() {
	const calls: Array<{ action: ClientAction; payload: unknown }> = [];
	const request = async <T>(action: ClientAction, payload: unknown) => {
		calls.push({ action, payload });
		const { path } = payload as { path: SchemaPathSegment[] };
		const nodes = path.length === 0 ? SCHEMAS : CATEGORIES;
		return { nodes } as T;
	};
	return { calls, request };
}

const CONN = "conn-1";

describe("explorer store", () => {
	test("expanding the root loads schemas once", async () => {
		const fake = createFakeRequest();
		const store = createExplorerStore(fake.request);
		await store.getState().toggle(CONN, []);
		const key = nodeKey(CONN, []);
		expect(store.getState().children[key]).toEqual({
			status: "loaded",
			nodes: SCHEMAS,
		});
		expect(fake.calls).toHaveLength(1);

		// Collapse and re-expand: cached children, no new request.
		await store.getState().toggle(CONN, []);
		expect(store.getState().expanded[key]).toBeUndefined();
		await store.getState().toggle(CONN, []);
		expect(fake.calls).toHaveLength(1);
	});

	test("expanding nested nodes requests each path", async () => {
		const fake = createFakeRequest();
		const store = createExplorerStore(fake.request);
		await store.getState().toggle(CONN, []);
		await store.getState().toggle(CONN, [{ kind: "schema", name: "app" }]);
		expect(fake.calls).toHaveLength(2);
		expect(
			store.getState().children[
				nodeKey(CONN, [{ kind: "schema", name: "app" }])
			],
		).toEqual({ status: "loaded", nodes: CATEGORIES });
	});

	test("refresh refetches root and every expanded path with refresh: true", async () => {
		const fake = createFakeRequest();
		const store = createExplorerStore(fake.request);
		await store.getState().toggle(CONN, []);
		const appPath: SchemaPathSegment[] = [{ kind: "schema", name: "app" }];
		await store.getState().toggle(CONN, appPath);
		fake.calls.length = 0;

		await store.getState().refresh(CONN);

		const refreshed = fake.calls.filter(
			(call) =>
				call.action === "schema.children" &&
				(call.payload as { refresh: boolean }).refresh,
		);
		expect(refreshed).toHaveLength(2);
		const refreshedPaths = refreshed.map(
			(call) => (call.payload as { path: SchemaPathSegment[] }).path,
		);
		expect(refreshedPaths).toContainEqual([]);
		expect(refreshedPaths).toContainEqual(appPath);
	});

	test("refresh drops cached children of collapsed nodes", async () => {
		const fake = createFakeRequest();
		const store = createExplorerStore(fake.request);
		const appPath: SchemaPathSegment[] = [{ kind: "schema", name: "app" }];
		await store.getState().toggle(CONN, []);
		await store.getState().toggle(CONN, appPath);
		await store.getState().toggle(CONN, appPath); // collapse
		fake.calls.length = 0;

		await store.getState().refresh(CONN);

		// Re-expanding after refresh must refetch, not serve stale cache.
		await store.getState().toggle(CONN, appPath);
		expect(fake.calls.length).toBeGreaterThanOrEqual(2);
	});

	test("failed loads land as errors and can be retried by refresh", async () => {
		let fail = true;
		const request = async <T>(): Promise<T> => {
			if (fail) {
				throw new Error("connection refused");
			}
			return { nodes: SCHEMAS } as T;
		};
		const store = createExplorerStore(request);
		await store.getState().toggle(CONN, []);
		expect(store.getState().children[nodeKey(CONN, [])]).toEqual({
			status: "error",
			message: "connection refused",
		});

		fail = false;
		await store.getState().refresh(CONN);
		expect(store.getState().children[nodeKey(CONN, [])]).toEqual({
			status: "loaded",
			nodes: SCHEMAS,
		});
	});

	test("reset clears tree state (socket reconnect)", async () => {
		const fake = createFakeRequest();
		const store = createExplorerStore(fake.request);
		await store.getState().toggle(CONN, []);
		store.getState().reset();
		expect(store.getState().children).toEqual({});
		expect(store.getState().expanded).toEqual({});
	});
});
