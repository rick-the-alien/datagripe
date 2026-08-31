import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppDb } from "../db/app/pool";

/**
 * Cookie sessions (docs/spec/auth-and-hardening.md): opaque tokens,
 * SHA-256 hashed at rest, 14-day fixed expiry. The plaintext token
 * exists only in the Set-Cookie header and the client's cookie jar.
 */

export interface SessionRecord {
	id: string;
	userId: string;
	csrfToken: string;
	expiresAt: Date;
}

export interface CreatedSession {
	record: SessionRecord;
	/** Plaintext token — goes into the cookie, never the database. */
	token: string;
}

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export interface SessionStore {
	create: (userId: string) => Promise<CreatedSession>;
	lookup: (token: string) => Promise<SessionRecord | null>;
	revoke: (sessionId: string) => Promise<void>;
	sweep: () => Promise<void>;
	stopSweep: () => void;
}

export function createSessionStore(appDb: AppDb): SessionStore {
	const sweepTimer = setInterval(() => {
		void store.sweep().catch(() => {});
	}, SWEEP_INTERVAL_MS);
	sweepTimer.unref();

	const store: SessionStore = {
		async create(userId) {
			const token = randomBytes(32).toString("base64url");
			const csrfToken = randomBytes(32).toString("base64url");
			const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
			const rows = await appDb<{ id: string }[]>`
				INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at)
				VALUES (${userId}, ${hashToken(token)}, ${csrfToken}, ${expiresAt.toISOString()})
				RETURNING id
			`;
			const row = rows[0];
			if (row === undefined) {
				throw new Error("Session insert returned no row");
			}
			return {
				record: { id: row.id, userId, csrfToken, expiresAt },
				token,
			};
		},

		async lookup(token) {
			const rows = await appDb<
				Array<{
					id: string;
					user_id: string;
					csrf_token: string;
					expires_at: string | Date;
				}>
			>`
				SELECT id, user_id, csrf_token, expires_at FROM sessions
				WHERE token_hash = ${hashToken(token)}
					AND revoked_at IS NULL
					AND expires_at > now()
			`;
			const row = rows[0];
			if (row === undefined) {
				return null;
			}
			return {
				id: row.id,
				userId: row.user_id,
				csrfToken: row.csrf_token,
				expiresAt: new Date(row.expires_at),
			};
		},

		async revoke(sessionId) {
			await appDb`
				UPDATE sessions SET revoked_at = now()
				WHERE id = ${sessionId} AND revoked_at IS NULL
			`;
		},

		async sweep() {
			await appDb`
				DELETE FROM sessions
				WHERE expires_at < now() OR revoked_at < now() - interval '7 days'
			`;
		},

		stopSweep() {
			clearInterval(sweepTimer);
		},
	};
	return store;
}

/** Constant-time comparison for CSRF tokens. */
export function csrfMatches(expected: string, provided: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(provided);
	return a.length === b.length && timingSafeEqual(a, b);
}

export const SESSION_COOKIE = "dg_session";

export function sessionCookie(token: string, secure: boolean): string {
	const parts = [
		`${SESSION_COOKIE}=${token}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
	];
	if (secure) {
		parts.push("Secure");
	}
	return parts.join("; ");
}

export function clearSessionCookie(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
