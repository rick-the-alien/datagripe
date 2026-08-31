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
 * Connection metadata state (never secrets) plus the connection dialog's
 * open/editing state. Loaded via `workspace.open` after the socket
 * connects; mutations go through WS actions and refresh the list.
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
};

export type DialogState =
	| { mode: "closed" }
	| { mode: "create" }
	| { mode: "edit"; connection: ConnectionMetadata };

export type ConnectionsState = {
	connections: ConnectionMetadata[];
	loaded: boolean;
	workspaceName: string | null;
	dialog: DialogState;
	saving: boolean;
	testing: boolean;
	testResult: ConnectionTestResult | null;
	load: () => Promise<WorkspaceOpenResult>;
	openCreateDialog: () => void;
	openEditDialog: (connection: ConnectionMetadata) => void;
	closeDialog: () => void;
	saveDraft: (
		draft: ConnectionDraft,
		editingId: string | null,
	) => Promise<void>;
	remove: (id: string) => Promise<void>;
	testDraft: (
		draft: ConnectionDraft,
		editingId: string | null,
	) => Promise<void>;
};

export function createConnectionsStore(request: WsRequestFn) {
	return create<ConnectionsState>()((set, get) => ({
		connections: [],
		loaded: false,
		workspaceName: null,
		dialog: { mode: "closed" },
		saving: false,
		testing: false,
		testResult: null,

		async load() {
			const result = await request<WorkspaceOpenResult>("workspace.open", {});
			set({
				connections: result.connections,
				workspaceName: result.workspace.name,
				loaded: true,
			});
			return result;
		},

		openCreateDialog() {
			set({ dialog: { mode: "create" }, testResult: null });
		},

		openEditDialog(connection) {
			set({ dialog: { mode: "edit", connection }, testResult: null });
		},

		closeDialog() {
			set({ dialog: { mode: "closed" }, testResult: null });
		},

		async saveDraft(draft, editingId) {
			set({ saving: true });
			try {
				const scoped = scopedPayload(draft);
				if (editingId === null) {
					await request("connection.create", {
						...scoped,
						idempotencyKey: crypto.randomUUID(),
					});
				} else {
					const { password: _password, ...withoutPassword } = scoped;
					await request("connection.update", {
						id: editingId,
						...withoutPassword,
						...(draft.password.length > 0 ? { password: draft.password } : {}),
						idempotencyKey: crypto.randomUUID(),
					});
				}
				set({ dialog: { mode: "closed" }, testResult: null });
				await get().load();
			} finally {
				set({ saving: false });
			}
		},

		async remove(id) {
			await request("connection.delete", {
				id,
				idempotencyKey: crypto.randomUUID(),
			});
			await get().load();
		},

		async testDraft(draft, editingId) {
			set({ testing: true, testResult: null });
			try {
				// Editing with an untouched (empty) password tests the saved
				// connection so the stored secret is exercised.
				const payload =
					editingId !== null && draft.password.length === 0
						? { connectionId: editingId }
						: { draft: scopedPayload(draft) };
				const result = await request<ConnectionTestResult>(
					"connection.test",
					payload,
				);
				set({ testResult: result });
			} catch (error) {
				set({
					testResult: {
						ok: false,
						error: {
							message: error instanceof Error ? error.message : "Test failed",
						},
					},
				});
			} finally {
				set({ testing: false });
			}
		},
	}));
}

export type ConnectionsStore = ReturnType<typeof createConnectionsStore>;
