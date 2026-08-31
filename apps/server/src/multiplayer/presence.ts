import type { PresenceUser } from "@datagripe/contracts";

/**
 * In-memory presence per workspace (docs/spec/multiplayer.md 6b).
 * Ephemeral by design: never persisted; a user is present while at least
 * one of their sockets is connected.
 */
export class PresenceTracker {
	private readonly workspaces = new Map<string, Map<string, PresenceUser>>();
	/** userId → open socket count (per workspace). */
	private readonly socketCounts = new Map<string, Map<string, number>>();

	join(
		workspaceId: string,
		user: { userId: string; email: string },
	): PresenceUser[] | null {
		const counts = this.socketCounts.get(workspaceId) ?? new Map();
		this.socketCounts.set(workspaceId, counts);
		const count = (counts.get(user.userId) ?? 0) + 1;
		counts.set(user.userId, count);

		const members = this.workspaces.get(workspaceId) ?? new Map();
		this.workspaces.set(workspaceId, members);
		const first = count === 1;
		members.set(user.userId, {
			userId: user.userId,
			email: user.email,
			activeDocumentId: members.get(user.userId)?.activeDocumentId ?? null,
			lastSeenAt: new Date().toISOString(),
		});
		return first ? this.list(workspaceId) : null;
	}

	leave(workspaceId: string, userId: string): PresenceUser[] | null {
		const counts = this.socketCounts.get(workspaceId);
		const count = (counts?.get(userId) ?? 0) - 1;
		if (count > 0) {
			counts?.set(userId, count);
			return null;
		}
		counts?.delete(userId);
		this.workspaces.get(workspaceId)?.delete(userId);
		return this.list(workspaceId);
	}

	focus(
		workspaceId: string,
		userId: string,
		documentId: string | null,
	): PresenceUser[] | null {
		const member = this.workspaces.get(workspaceId)?.get(userId);
		if (member === undefined || member.activeDocumentId === documentId) {
			return null; // unchanged → no broadcast
		}
		member.activeDocumentId = documentId;
		member.lastSeenAt = new Date().toISOString();
		return this.list(workspaceId);
	}

	list(workspaceId: string): PresenceUser[] {
		return [...(this.workspaces.get(workspaceId)?.values() ?? [])];
	}
}
