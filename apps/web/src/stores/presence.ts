import type { PresenceUser, ViewStatePayload } from "@datagripe/contracts";
import { create } from "zustand";
import { wsClient } from "../api/ws";

/**
 * Presence and shared views (docs/spec/multiplayer.md 6b/6c). Remote
 * view states are stored for every broadcasting member; the renderer
 * shows them only while following (opt-in).
 */

export type PresenceState = {
	users: PresenceUser[];
	/** Latest broadcast per user; rendered only for the followed user. */
	remoteViews: Record<string, ViewStatePayload>;
	followingUserId: string | null;
	followedBy: string[];
	setUsers: (users: PresenceUser[]) => void;
	setRemoteView: (view: ViewStatePayload) => void;
	follow: (userId: string) => void;
	unfollow: () => void;
	setFollowedBy: (userId: string, following: boolean) => void;
	reset: () => void;
};

export const usePresenceStore = create<PresenceState>()((set, get) => ({
	users: [],
	remoteViews: {},
	followingUserId: null,
	followedBy: [],

	setUsers(users) {
		const following = get().followingUserId;
		set({
			users,
			// Drop follow state when the followed member goes offline.
			followingUserId:
				following !== null && users.some((u) => u.userId === following)
					? following
					: null,
		});
	},

	setRemoteView(view) {
		set({
			remoteViews: { ...get().remoteViews, [view.userId]: view },
		});
	},

	follow(userId) {
		set({ followingUserId: userId });
		void wsClient.request("view.follow", { userId }).catch(() => {});
	},

	unfollow() {
		const current = get().followingUserId;
		set({ followingUserId: null });
		if (current !== null) {
			void wsClient
				.request("view.unfollow", { userId: current })
				.catch(() => {});
		}
	},

	setFollowedBy(userId, following) {
		const current = get().followedBy;
		set({
			followedBy: following
				? [...new Set([...current, userId])]
				: current.filter((id) => id !== userId),
		});
	},

	reset() {
		set({
			users: [],
			remoteViews: {},
			followingUserId: null,
			followedBy: [],
		});
	},
}));
