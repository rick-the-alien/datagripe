import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionBootstrap } from "@datagripe/contracts";
import { SQL } from "bun";
import { createSessionStore, SESSION_COOKIE } from "../auth/sessions";
import { migrate } from "../db/app/migrate";
import type { AppDb } from "../db/app/pool";
import { createRateLimiter } from "../security/rateLimit";
import { createAuthRoutes } from "./auth";

/** Auth route integration tests against a real scratch app database. */

const ADMIN_URL = "postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_auth_test";

async function probe(): Promise<boolean> {
	try {
		const sql = new SQL(ADMIN_URL, { connectionTimeout: 2 });
		await sql`SELECT 1`;
		await sql.close();
		return true;
	} catch {
		return false;
	}
}

const reachable = await probe();
const pgTest = reachable ? test : test.skip;

let appDb: AppDb;
let routes: ReturnType<typeof createAuthRoutes>;
let closedSessions: string[];

function req(
	path: string,
	init?: { method?: string; body?: unknown; cookie?: string; csrf?: string },
): Request {
	return new Request(`http://localhost${path}`, {
		method: init?.method ?? "GET",
		headers: {
			...(init?.body !== undefined
				? { "content-type": "application/json" }
				: {}),
			...(init?.cookie !== undefined
				? { cookie: `${SESSION_COOKIE}=${init.cookie}` }
				: {}),
			...(init?.csrf !== undefined ? { "x-csrf-token": init.csrf } : {}),
		},
		...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
	});
}

function sessionCookieOf(res: Response): string {
	const header = res.headers.get("set-cookie") ?? "";
	const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
	expect(match).not.toBeNull();
	return match?.[1] ?? "";
}

beforeAll(async () => {
	if (!reachable) {
		return;
	}
	const admin = new SQL(ADMIN_URL);
	const existing =
		await admin`SELECT 1 FROM pg_database WHERE datname = ${SCRATCH_DB}`;
	if (existing.length === 0) {
		await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
	}
	await admin.close();
	appDb = new SQL(
		`postgres://datagripe:datagripe@localhost:5432/${SCRATCH_DB}`,
	);
	await migrate(appDb);
	await appDb.unsafe(
		"TRUNCATE sessions, workspace_members, workspaces, users CASCADE",
	);
	closedSessions = [];
	routes = createAuthRoutes({
		appDb,
		config: {
			NODE_ENV: "test",
			PORT: 3001,
			WEB_ORIGIN: "http://localhost:5173",
			APP_DATABASE_URL: "",
			CONNECTION_ENCRYPTION_KEY: "test-key-0123456789abcdef0123",
			SESSION_SECRET: "test-secret-0123456789abcdef01234",
			QUERY_TIMEOUT_MS: 30_000,
			QUERY_MAX_ROWS: 10_000,
			QUERY_MAX_BYTES: 25_000_000,
			MAX_CONCURRENT_QUERIES_PER_USER: 3,
			ALLOW_SIGNUP: false,
			TARGET_HOST_ALLOWLIST: "",
		},
		sessions: createSessionStore(appDb),
		rateLimiter: createRateLimiter({
			"auth.login.ip": { capacity: 30, refillPerMinute: 30 },
			"auth.login.email": { capacity: 5, refillPerMinute: 5 },
		}),
		closeSocketsForSession: (sessionId) => closedSessions.push(sessionId),
	});
});

afterAll(async () => {
	await appDb?.close();
});

const ALICE = { email: "Alice@Example.com", password: "correct-horse-battery" };

describe("auth routes", () => {
	pgTest(
		"bootstrap signup creates the first account and a session cookie",
		async () => {
			const before = await routes.session(req("/api/session"));
			const boot = (await before.json()) as SessionBootstrap;
			expect(boot.bootstrap).toBe(true);
			expect(boot.user).toBeNull();

			const res = await routes.signup(
				req("/api/auth/signup", { method: "POST", body: ALICE }),
			);
			expect(res.status).toBe(200);
			const token = sessionCookieOf(res);
			expect(token.length).toBeGreaterThan(20);

			const after = await routes.session(
				req("/api/session", { cookie: token }),
			);
			const booted = (await after.json()) as SessionBootstrap;
			expect(booted.user).toMatchObject({ email: "alice@example.com" });
			expect(booted.workspace).toMatchObject({ name: "Local", role: "owner" });
			expect(booted.csrfToken).not.toBeNull();
		},
	);

	pgTest("short passwords are rejected", async () => {
		const res = await routes.signup(
			req("/api/auth/signup", {
				method: "POST",
				body: { email: "b@example.com", password: "short" },
			}),
		);
		expect(res.status).toBe(400);
	});

	pgTest(
		"signup is closed after bootstrap when ALLOW_SIGNUP=false",
		async () => {
			const res = await routes.signup(
				req("/api/auth/signup", {
					method: "POST",
					body: { email: "bob@example.com", password: "another-good-password" },
				}),
			);
			expect(res.status).toBe(403);
		},
	);

	pgTest("login rejects wrong credentials and accepts right ones", async () => {
		const bad = await routes.login(
			req("/api/auth/login", {
				method: "POST",
				body: { email: "alice@example.com", password: "wrong-password!!" },
			}),
		);
		expect(bad.status).toBe(401);

		const good = await routes.login(
			req("/api/auth/login", { method: "POST", body: ALICE }),
		);
		expect(good.status).toBe(200);
		expect(sessionCookieOf(good).length).toBeGreaterThan(20);
	});

	pgTest("logout requires the CSRF token and revokes the session", async () => {
		const login = await routes.login(
			req("/api/auth/login", { method: "POST", body: ALICE }),
		);
		const token = sessionCookieOf(login);

		const boot = (await (
			await routes.session(req("/api/session", { cookie: token }))
		).json()) as SessionBootstrap;

		const noCsrf = await routes.logout(
			req("/api/auth/logout", { method: "POST", cookie: token }),
		);
		expect(noCsrf.status).toBe(403);

		const ok = await routes.logout(
			req("/api/auth/logout", {
				method: "POST",
				cookie: token,
				csrf: boot.csrfToken ?? "",
			}),
		);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("set-cookie")).toContain("Max-Age=0");

		const after = await routes.session(req("/api/session", { cookie: token }));
		expect(((await after.json()) as SessionBootstrap).user).toBeNull();
		expect(closedSessions.length).toBe(1);
	});

	pgTest("login rate limit kicks in per email", async () => {
		let last = 0;
		for (let i = 0; i < 7; i++) {
			const res = await routes.login(
				req("/api/auth/login", {
					method: "POST",
					body: { email: "alice@example.com", password: "wrong-password!!" },
				}),
			);
			last = res.status;
		}
		expect(last).toBe(429);
	});
});
