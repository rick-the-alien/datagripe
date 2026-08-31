import type { SessionBootstrap } from "@datagripe/contracts";
import { create } from "zustand";
import { wsClient } from "../api/ws";

/**
 * Session state: the /api/session bootstrap plus login/signup/logout.
 * The workspace renders only after a successful bootstrap; AuthScreen
 * covers the unauthenticated case.
 */

export type SessionState = {
	bootstrap: SessionBootstrap | null;
	error: string | null;
	busy: boolean;
	load: () => Promise<void>;
	login: (email: string, password: string) => Promise<boolean>;
	signup: (email: string, password: string) => Promise<boolean>;
	logout: () => Promise<void>;
};

async function post(
	path: string,
	body: unknown,
	csrfToken?: string,
): Promise<Response> {
	return fetch(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(csrfToken !== undefined ? { "x-csrf-token": csrfToken } : {}),
		},
		body: JSON.stringify(body),
	});
}

export const useSessionStore = create<SessionState>()((set, get) => ({
	bootstrap: null,
	error: null,
	busy: false,

	async load() {
		const res = await fetch("/api/session");
		const bootstrap = (await res.json()) as SessionBootstrap;
		set({ bootstrap });
	},

	async login(email, password) {
		set({ busy: true, error: null });
		try {
			const res = await post("/api/auth/login", { email, password });
			if (!res.ok) {
				const body = (await res.json()) as {
					error?: { message?: string };
				};
				set({ error: body.error?.message ?? "Login failed" });
				return false;
			}
			await get().load();
			return true;
		} finally {
			set({ busy: false });
		}
	},

	async signup(email, password) {
		set({ busy: true, error: null });
		try {
			const res = await post("/api/auth/signup", { email, password });
			if (!res.ok) {
				const body = (await res.json()) as {
					error?: { message?: string };
				};
				set({ error: body.error?.message ?? "Signup failed" });
				return false;
			}
			await get().load();
			return true;
		} finally {
			set({ busy: false });
		}
	},

	async logout() {
		const csrfToken = get().bootstrap?.csrfToken ?? undefined;
		await post("/api/auth/logout", {}, csrfToken).catch(() => {});
		wsClient.disconnect();
		set({ bootstrap: null, error: null });
		await get().load();
	},
}));
