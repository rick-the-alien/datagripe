import type {
	ConnectionAdapter,
	ConnectionMetadata,
	ConnectionTestResult,
	WorkspaceOpenResult,
} from "@datagripe/contracts";
import { ADAPTER_CAPABILITIES } from "@datagripe/contracts";
import { create } from "zustand";
import type { WsRequestFn } from "../api/ws";

/**
 * Connection metadata state (never secrets). Loaded via `workspace.open`
 * after the socket connects; mutations go through WS actions and refresh
 * the list. The create/edit form lives in a dock tab (ConnectionForm)
 * which keeps its own draft/test UI state.
 */

/** Only fields the adapter actually uses — nothing phantom is stored. */
function scopedPayload(draft: ConnectionDraft) {
	const caps = ADAPTER_CAPABILITIES[draft.adapter];
	return {
		name: draft.name,
		adapter: draft.adapter,
		...(caps.fields.includes("host") ? { host: draft.host } : {}),
		...(caps.fields.includes("port") ? { port: draft.port } : {}),
		databaseName: draft.databaseName,
		...(caps.fields.includes("username") ? { username: draft.username } : {}),
		password: draft.password,
		...(caps.fields.includes("tlsMode") ? { tlsMode: draft.tlsMode } : {}),
		readOnly: draft.readOnly,
		showAllSchemas: draft.showAllSchemas,
	};
}

export type ConnectionDraft = {
	adapter: ConnectionAdapter;
	name: string;
	host: string;
	port: number;
	databaseName: string;
	username: string;
	/** Empty when editing and keeping the stored password. */
	password: string;
	tlsMode: "disable" | "require" | "verify-full";
	readOnly: boolean;
	/** Tree shows every schema as an expandable level. */
	showAllSchemas: boolean;
};

export type ConnectionsState = {
	connections: ConnectionMetadata[];
	loaded: boolean;
	workspaceName: string | null;
	load: () => Promise<WorkspaceOpenResult>;
	/** Returns the saved connection's id (managed connections only). */
	saveDraft: (
		draft: ConnectionDraft,
		editingId: string | null,
	) => Promise<string | null>;
	remove: (id: string) => Promise<void>;
	testDraft: (
		draft: ConnectionDraft,
		editingId: string | null,
	) => Promise<ConnectionTestResult>;
};

export function createConnectionsStore(request: WsRequestFn) {
	return create<ConnectionsState>()((set, get) => ({
		connections: [],
		loaded: false,
		workspaceName: null,

		async load() {
			const result = await request<WorkspaceOpenResult>("workspace.open", {});
			set({
				connections: result.connections,
				workspaceName: result.workspace.name,
				loaded: true,
			});
			return result;
		},

		async saveDraft(draft, editingId) {
			const scoped = scopedPayload(draft);
			let id: string | null = editingId;
			if (editingId === null) {
				const created = await request<ConnectionMetadata>("connection.create", {
					...scoped,
					idempotencyKey: crypto.randomUUID(),
				});
				id = created.id;
			} else {
				const { password: _password, ...withoutPassword } = scoped;
				await request("connection.update", {
					id: editingId,
					...withoutPassword,
					...(draft.password.length > 0 ? { password: draft.password } : {}),
					idempotencyKey: crypto.randomUUID(),
				});
			}
			await get().load();
			return id;
		},

		async remove(id) {
			await request("connection.delete", {
				id,
				idempotencyKey: crypto.randomUUID(),
			});
			await get().load();
		},

		async testDraft(draft, editingId) {
			// Editing with an untouched (empty) password tests the saved
			// connection so the stored secret is exercised.
			const payload =
				editingId !== null && draft.password.length === 0
					? { connectionId: editingId }
					: { draft: scopedPayload(draft) };
			try {
				return await request<ConnectionTestResult>("connection.test", payload);
			} catch (error) {
				return {
					ok: false,
					error: {
						message: error instanceof Error ? error.message : "Test failed",
					},
				};
			}
		},
	}));
}

export type ConnectionsStore = ReturnType<typeof createConnectionsStore>;
