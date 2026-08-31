import { describe, expect, test } from "bun:test";
import type { ClientAction } from "@datagripe/contracts/ws";
import { createConnectionsService } from "../connections/service";
import { createRateLimiter } from "../security/rateLimit";
import { type AuthContext, createDispatcher } from "./dispatch";

/** RBAC and rate-limit enforcement in the dispatcher (unit-level). */

const WORKSPACE = { id: "00000000-0000-4000-8000-000000000001", name: "Local" };

function ctx(role: AuthContext["role"]): AuthContext {
	return {
		userId: "00000000-0000-4000-8000-000000000002",
		sessionId: "00000000-0000-4000-8000-000000000003",
		workspace: WORKSPACE,
		role,
	};
}

function createTestDispatcher() {
	const calls: Array<{ action: string }> = [];
	const executions = {
		start: async () => ({ executionId: crypto.randomUUID() }),
		cancel: async () => ({ executionId: "", status: "running" as const }),
		replay: () => [],
		get: () => undefined,
	};
	const appDb = (async () => []) as never;
	const connections = createConnectionsService({
		appDb,
		keyring: {} as never,
		adapters: {} as never,
		predefined: new Map(),
		ssrf: { assertHostAllowed: async () => {} },
	});
	const dispatch = createDispatcher({
		appDb,
		connections,
		documents: {} as never,
		presence: {} as never,
		viewThrottle: {} as never,
		hub: {} as never,
		executions: {
			start: async () => {
				calls.push({ action: "execution.start" });
				return { executionId: crypto.randomUUID() };
			},
			cancel: executions.cancel,
			replay: executions.replay,
			get: executions.get,
		},
		rateLimiter: createRateLimiter({
			"execution.start": { capacity: 2, refillPerMinute: 0 },
		}),
	});
	return { dispatch, calls };
}

const START_PAYLOAD = {
	connectionId: "c",
	sql: "select 1",
	idempotencyKey: "idem-key-0001",
};

describe("dispatcher authorization", () => {
	test("viewer cannot start executions; editor can", async () => {
		const { dispatch, calls } = createTestDispatcher();
		await expect(
			dispatch(ctx("viewer"), "execution.start", START_PAYLOAD),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(calls).toHaveLength(0);

		const result = await dispatch(
			ctx("editor"),
			"execution.start",
			START_PAYLOAD,
		);
		expect(result).toHaveProperty("executionId");
	});

	test("member management is owner-only", async () => {
		const { dispatch } = createTestDispatcher();
		await expect(
			dispatch(ctx("editor"), "workspace.member.add", {
				email: "x@example.com",
				role: "viewer",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			dispatch(ctx("viewer"), "workspace.member.remove", {
				userId: crypto.randomUUID(),
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("connection mutations require editor", async () => {
		const { dispatch } = createTestDispatcher();
		await expect(
			dispatch(ctx("viewer"), "connection.delete", {
				id: "x",
				idempotencyKey: "idem-key-0002",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("rate limit rejects after capacity", async () => {
		const { dispatch } = createTestDispatcher();
		await dispatch(ctx("editor"), "execution.start", START_PAYLOAD);
		await dispatch(ctx("editor"), "execution.start", START_PAYLOAD);
		await expect(
			dispatch(ctx("editor"), "execution.start", START_PAYLOAD),
		).rejects.toMatchObject({ code: "RATE_LIMITED" });
	});

	test("unknown actions are rejected as not implemented", async () => {
		const { dispatch } = createTestDispatcher();
		await expect(
			dispatch(ctx("owner"), "layout.save" as ClientAction, {}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
