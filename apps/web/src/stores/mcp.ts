import type {
	McpMode,
	McpState,
	McpTokenCreateResult,
} from "@datagripe/contracts";
import { create } from "zustand";
import { wsClient } from "../api/ws";

/**
 * The mcp panel's state (docs/spec/mcp.md "The panel").
 *
 * Nothing here polls, and nothing loads until the section is expanded:
 * reading the state walks the datasource paths to count the files an
 * agent would see, and that is a disk read nobody asked for while the
 * section sits collapsed — which, by default, it does.
 *
 * `revealed` is the one piece of state that only exists in memory. A
 * token value is shown once, at creation; there is no second chance to
 * copy it because there is nowhere it was kept.
 */

export interface McpUiState {
	state: McpState | null;
	loading: boolean;
	busy: boolean;
	error: string | null;
	/** The token created in this session, for as long as the panel is open. */
	revealed: { id: string; name: string; value: string } | null;
	load: () => Promise<void>;
	setSettings: (settings: { enabled: boolean; mode: McpMode }) => Promise<void>;
	createToken: (name: string) => Promise<void>;
	revokeToken: (id: string) => Promise<void>;
	dismissRevealed: () => void;
	reset: () => void;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : "Something went wrong";
}

export const useMcpStore = create<McpUiState>()((set, get) => ({
	state: null,
	loading: false,
	busy: false,
	error: null,
	revealed: null,

	async load() {
		if (get().loading) {
			return;
		}
		set({ loading: true });
		try {
			const state = await wsClient.request<McpState>("mcp.settings", {});
			set({ state, error: null });
		} catch (error) {
			set({ error: message(error) });
		} finally {
			set({ loading: false });
		}
	},

	async setSettings(settings) {
		set({ busy: true });
		try {
			const state = await wsClient.request<McpState>(
				"mcp.settings.set",
				settings,
			);
			set({ state, error: null });
		} catch (error) {
			set({ error: message(error) });
		} finally {
			set({ busy: false });
		}
	},

	async createToken(name) {
		set({ busy: true });
		try {
			const result = await wsClient.request<McpTokenCreateResult>(
				"mcp.token.create",
				{ name },
			);
			set({
				state: result.state,
				revealed: {
					id: result.token.id,
					name: result.token.name,
					value: result.value,
				},
				error: null,
			});
		} catch (error) {
			set({ error: message(error) });
		} finally {
			set({ busy: false });
		}
	},

	async revokeToken(id) {
		set({ busy: true });
		try {
			const state = await wsClient.request<McpState>("mcp.token.revoke", {
				id,
			});
			const revealed = get().revealed;
			set({
				state,
				error: null,
				revealed: revealed?.id === id ? null : revealed,
			});
		} catch (error) {
			set({ error: message(error) });
		} finally {
			set({ busy: false });
		}
	},

	dismissRevealed() {
		set({ revealed: null });
	},

	reset() {
		set({ state: null, error: null, revealed: null, busy: false });
	},
}));
