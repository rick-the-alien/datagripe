import {
	loginRequestSchema,
	type SessionBootstrap,
	signupRequestSchema,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import {
	createAccount,
	defaultWorkspaceFor,
	findUserByEmail,
	hashPassword,
	MIN_PASSWORD_LENGTH,
	normalizeEmail,
	userCount,
	verifyPassword,
} from "../auth/accounts";
import {
	clearSessionCookie,
	csrfMatches,
	SESSION_COOKIE,
	type SessionStore,
	sessionCookie,
} from "../auth/sessions";
import type { AppConfig } from "../config";
import type { AppDb } from "../db/app/pool";
import { log } from "../log";
import type { RateLimiter } from "../security/rateLimit";
import { errorResponse } from "./errors";

/**
 * HTTP auth routes (docs/spec/auth-and-hardening.md): signup (bootstrap /
 * ALLOW_SIGNUP), login, logout, and the session bootstrap endpoint the
 * web app loads first. Everything else travels over the WebSocket.
 */

export interface AuthRouteDeps {
	appDb: AppDb;
	config: AppConfig;
	sessions: SessionStore;
	rateLimiter: RateLimiter;
	/** Close every socket bound to a session (logout). */
	closeSocketsForSession: (sessionId: string) => void;
}

function parseCookies(header: string | null): Record<string, string> {
	const cookies: Record<string, string> = {};
	if (header === null) {
		return cookies;
	}
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) {
			continue;
		}
		cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
	}
	return cookies;
}

export function sessionTokenFrom(req: Request): string | null {
	return parseCookies(req.headers.get("cookie"))[SESSION_COOKIE] ?? null;
}

export async function sessionFromRequest(sessions: SessionStore, req: Request) {
	const token = sessionTokenFrom(req);
	if (token === null) {
		return null;
	}
	return sessions.lookup(token);
}

function clientIp(req: Request): string {
	// Direct connections only; no proxy header trust (self-hosted v1).
	return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"content-type": "application/json",
			...(init?.headers ?? {}),
		},
	});
}

export function createAuthRoutes(deps: AuthRouteDeps) {
	const { appDb, config, sessions, rateLimiter } = deps;
	const secureCookie = config.NODE_ENV === "production";

	async function bootstrapFor(
		userId: string | null,
	): Promise<SessionBootstrap> {
		const count = await userCount(appDb);
		if (userId === null) {
			return {
				user: null,
				workspace: null,
				csrfToken: null,
				wsUrl: `ws://localhost:${config.PORT}/ws`,
				bootstrap: count === 0,
				allowSignup: config.ALLOW_SIGNUP,
			};
		}
		const [userRow, workspace] = await Promise.all([
			appDb<{ email: string }[]>`SELECT email FROM users WHERE id = ${userId}`,
			defaultWorkspaceFor(appDb, userId),
		]);
		return {
			user:
				userRow[0] === undefined
					? null
					: { id: userId, email: userRow[0].email },
			workspace,
			csrfToken: null, // filled by the caller, which holds the session
			wsUrl: `ws://localhost:${config.PORT}/ws`,
			bootstrap: count === 0,
			allowSignup: config.ALLOW_SIGNUP,
		};
	}

	return {
		async session(req: Request): Promise<Response> {
			const session = await sessionFromRequest(sessions, req);
			const bootstrap = await bootstrapFor(session?.userId ?? null);
			return json({ ...bootstrap, csrfToken: session?.csrfToken ?? null });
		},

		async signup(req: Request): Promise<Response> {
			const requestId = crypto.randomUUID();
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return errorResponse(
					400,
					ErrorCodes.BadRequest,
					"Invalid JSON",
					requestId,
				);
			}
			const parsed = signupRequestSchema.safeParse(body);
			if (!parsed.success) {
				return errorResponse(
					400,
					ErrorCodes.BadRequest,
					`Email and a password of at least ${MIN_PASSWORD_LENGTH} characters are required`,
					requestId,
				);
			}
			const email = normalizeEmail(parsed.data.email);
			const count = await userCount(appDb);
			if (count > 0 && !config.ALLOW_SIGNUP) {
				return errorResponse(
					403,
					ErrorCodes.Forbidden,
					"Signup is disabled on this server",
					requestId,
				);
			}
			if ((await findUserByEmail(appDb, email)) !== null) {
				return errorResponse(
					409,
					ErrorCodes.Conflict,
					"An account with this email already exists",
					requestId,
				);
			}
			const passwordHash = await hashPassword(parsed.data.password);
			const account = await createAccount(appDb, email, passwordHash);
			log.audit("auth.signup", { userId: account.userId, email });
			const created = await sessions.create(account.userId);
			return json(
				{ ok: true },
				{
					headers: { "set-cookie": sessionCookie(created.token, secureCookie) },
				},
			);
		},

		async login(req: Request): Promise<Response> {
			const requestId = crypto.randomUUID();
			const ip = clientIp(req);
			if (!rateLimiter.take("auth.login.ip", ip)) {
				return errorResponse(
					429,
					ErrorCodes.RateLimited,
					"Too many attempts",
					requestId,
				);
			}
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return errorResponse(
					400,
					ErrorCodes.BadRequest,
					"Invalid JSON",
					requestId,
				);
			}
			const parsed = loginRequestSchema.safeParse(body);
			if (!parsed.success) {
				return errorResponse(
					400,
					ErrorCodes.BadRequest,
					"Email and password are required",
					requestId,
				);
			}
			const email = normalizeEmail(parsed.data.email);
			if (!rateLimiter.take("auth.login.email", email)) {
				return errorResponse(
					429,
					ErrorCodes.RateLimited,
					"Too many attempts",
					requestId,
				);
			}
			const user = await findUserByEmail(appDb, email);
			const ok =
				user !== null &&
				(await verifyPassword(parsed.data.password, user.passwordHash));
			if (!ok || user === null) {
				log.audit("auth.login.failure", { email, ip });
				return errorResponse(
					401,
					ErrorCodes.Unauthorized,
					"Invalid email or password",
					requestId,
				);
			}
			log.audit("auth.login.success", { userId: user.id, ip });
			const created = await sessions.create(user.id);
			return json(
				{ ok: true },
				{
					headers: { "set-cookie": sessionCookie(created.token, secureCookie) },
				},
			);
		},

		async logout(req: Request): Promise<Response> {
			const requestId = crypto.randomUUID();
			const session = await sessionFromRequest(sessions, req);
			if (session === null) {
				return json({ ok: true });
			}
			const csrf = req.headers.get("x-csrf-token") ?? "";
			if (!csrfMatches(session.csrfToken, csrf)) {
				return errorResponse(
					403,
					ErrorCodes.Forbidden,
					"CSRF token mismatch",
					requestId,
				);
			}
			await sessions.revoke(session.id);
			deps.closeSocketsForSession(session.id);
			log.audit("auth.logout", { userId: session.userId });
			return json(
				{ ok: true },
				{ headers: { "set-cookie": clearSessionCookie() } },
			);
		},
	};
}
