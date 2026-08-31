/**
 * View-state broadcast throttle (docs/spec/multiplayer.md 6c): at most
 * 4 Hz per user. The server stores nothing; state clears on disconnect.
 */

const MIN_INTERVAL_MS = 250;

export class ViewBroadcastThrottle {
	private readonly lastBroadcastAt = new Map<string, number>();

	constructor(private readonly now: () => number = Date.now) {}

	allow(userId: string): boolean {
		const now = this.now();
		const last = this.lastBroadcastAt.get(userId) ?? 0;
		if (now - last < MIN_INTERVAL_MS) {
			return false;
		}
		this.lastBroadcastAt.set(userId, now);
		return true;
	}

	removeUser(userId: string): void {
		this.lastBroadcastAt.delete(userId);
	}
}
