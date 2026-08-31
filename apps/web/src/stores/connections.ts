import type {
	ConnectionMetadata,
	ConnectionTestResult,
	WorkspaceOpenResult,
} from "@datagripe/contracts";
import { create } from "zustand";
import type { WsRequestFn } from "../api/ws";

/**
 * Connection metadata state (never secrets) plus the connection dialog's
 * open/editing state. Loaded via `workspace.open` after the socket
 * connects; mutations go through WS actions and refresh the list.
 */

export type ConnectionDraft = {
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
	load: () => Promise<void>;
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
				if (editingId === null) {
					await request("connection.create", {
						...draft,
						adapter: "postgres",
						idempotencyKey: crypto.randomUUID(),
					});
				} else {
					await request("connection.update", {
						id: editingId,
						name: draft.name,
						host: draft.host,
						port: draft.port,
						databaseName: draft.databaseName,
						username: draft.username,
						...(draft.password.length > 0 ? { password: draft.password } : {}),
						tlsMode: draft.tlsMode,
						readOnly: draft.readOnly,
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
						: {
								draft: {
									...draft,
									adapter: "postgres" as const,
								},
							};
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
