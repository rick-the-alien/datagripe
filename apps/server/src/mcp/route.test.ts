import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createAccount } from "../auth/accounts";
import type { AppConfig } from "../config";
import type { ConnectionsService } from "../connections/service";
import { migrate } from "../db/app/migrate";
import type { AppDb } from "../db/app/pool";
import type { DocumentsService } from "../documents/service";
import type {
	ExecutionOptions,
	ExecutionRegistry,
} from "../execution/registry";
import { createRateLimiter } from "../security/rateLimit";
import { createWorkspace } from "../workspaces/service";
import type { McpDeps } from "./context";
import { createMcpRoute } from "./route";
import { createMcpService } from "./service";

/**
 * The endpoint end to end (docs/spec/mcp.md): authentication, the two
 * off switches, the JSON-RPC transcript, and — the one that matters —
 * that a read-only project cannot be talked into a write.
 *
 * The target database is stubbed, deliberately. What is under test is
 * the decision to run a statement at all and the options it runs with;
 * whether Postgres honours `SET TRANSACTION READ ONLY` is Postgres's
 * test, and the adapter's.
 */

const ADMIN_URL = "postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_mcp_test";

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
let userId: string;
let workspaceId: string;
let otherWorkspaceId: string;
let deps: McpDeps;
let handle: ReturnType<typeof createMcpRoute>;
let service: ReturnType<typeof createMcpService>;
/** Every `runOnce` the tools asked for, so the options can be asserted. */
let runs: Array<{ sql: string; options: ExecutionOptions }>;

const DATASOURCE = {
	id: "predefined:demo",
	workspaceId: "",
	name: "demo",
	adapter: "postgres" as const,
	host: "localhost",
	port: 5432,
	databaseName: "demo",
	username: "demo",
	tlsMode: "disable" as const,
	readOnly: false,
	showAllSchemas: false,
	domainExportPath: null,
	paths: [],
	source: "predefined" as const,
	branding: null,
	unavailable: null,
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
};

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
		"TRUNCATE mcp_tokens, mcp_settings, workspace_members, workspaces, users CASCADE",
	);
	userId = (await createAccount(appDb, "mcp@example.com", "hash")).userId;
	workspaceId = (await createWorkspace(appDb, userId, "Main")).id;
	otherWorkspaceId = (await createWorkspace(appDb, userId, "Other")).id;
	runs = [];

	deps = {
		appDb,
		config: {
			WEB_ORIGIN: "http://localhost:5173",
			PORT: 3001,
			AUTH_DISABLED: false,
			MCP_ENABLED: true,
			MCP_MAX_ROWS: 200,
			MCP_MAX_BYTES: 1_000_000,
			MCP_READ_MAX_BYTES: 65_536,
			MCP_INSTRUCTIONS_MAX_BYTES: 16_384,
		} as AppConfig,
		connections: {
			listConnections: async () => [DATASOURCE],
			schemaChildren: async () => [
				{ kind: "schema", name: "public", hasChildren: true },
			],
			describeObject: async () => ({ tabs: {} }),
		} as unknown as ConnectionsService,
		documents: {
			listDocuments: async () => [
				{
					id: "11111111-1111-4111-8111-111111111111",
					title: "AGENTS.md",
					revision: 1,
					updatedAt: new Date().toISOString(),
					origin: null,
					language: "markdown" as const,
				},
			],
			getDocument: async () => ({
				id: "11111111-1111-4111-8111-111111111111",
				workspaceId,
				title: "AGENTS.md",
				language: "markdown" as const,
				content: "# how it fits together\nbilling.invoices is authoritative.",
				revision: 1,
				origin: null,
				updatedAt: new Date().toISOString(),
			}),
		} as unknown as DocumentsService,
		executions: {
			runOnce: async (
				_userId: string,
				_workspace: unknown,
				request: { sql: string },
				options: ExecutionOptions,
			) => {
				runs.push({ sql: request.sql, options });
				return {
					executionId: crypto.randomUUID(),
					status: "succeeded" as const,
					columns: [{ name: "one", dataType: "unknown" }],
					rows: [[1]],
					resultSets: 1,
					statements: [{ command: "SELECT" }],
					rowCount: 1,
					truncated: false,
					elapsedMs: 3,
				};
			},
		} as unknown as ExecutionRegistry,
		rateLimiter: createRateLimiter({
			"mcp.tools.call": { capacity: 1000, refillPerMinute: 1000 },
			"mcp.query": { capacity: 1000, refillPerMinute: 1000 },
		}),
		hostFs: { roots: [], disabled: false },
	};
	handle = createMcpRoute(deps);
	service = createMcpService(deps);
});

afterAll(async () => {
	deps?.rateLimiter.stop();
	await appDb?.close();
});

function post(
	body: unknown,
	token: string | null,
	project = workspaceId,
): Promise<Response> {
	return handle(
		new Request(`http://localhost:3001/mcp/${project}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token === null ? {} : { authorization: `Bearer ${token}` }),
			},
			body: JSON.stringify(body),
		}),
		project,
	);
}

function rpc(method: string, params?: unknown): unknown {
	return {
		jsonrpc: "2.0",
		id: 1,
		method,
		...(params === undefined ? {} : { params }),
	};
}

async function callTool(
	token: string,
	name: string,
	args: unknown = {},
): Promise<{
	isError: boolean;
	text: string;
	payload: Record<string, unknown> | null;
}> {
	const response = await post(
		rpc("tools/call", { name, arguments: args }),
		token,
	);
	const body = (await response.json()) as {
		result?: { content: Array<{ text: string }>; isError?: boolean };
	};
	const text = body.result?.content[0]?.text ?? "";
	let payload: Record<string, unknown> | null = null;
	try {
		payload = JSON.parse(text) as Record<string, unknown>;
	} catch {
		payload = null;
	}
	return { isError: body.result?.isError === true, text, payload };
}

/** A live token for the project, with MCP on in the given mode. */
async function enable(mode: "read-only" | "read-write"): Promise<string> {
	await service.setSettings({ id: workspaceId, name: "Main" }, userId, {
		enabled: true,
		mode,
	});
	const created = await service.createToken(
		{ id: workspaceId, name: "Main" },
		userId,
		`client-${mode}`,
	);
	return created.value;
}

describe("mcp endpoint", () => {
	pgTest("a GET is not a stream, and says so", async () => {
		const response = await handle(
			new Request(`http://localhost:3001/mcp/${workspaceId}`),
			workspaceId,
		);
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
	});

	pgTest("no bearer token is a 401 that names what is missing", async () => {
		const response = await post(rpc("initialize"), null);
		expect(response.status).toBe(401);
		const body = (await response.json()) as { error: { message: string } };
		expect(body.error.message).toContain("Bearer");
	});

	pgTest("an unknown token is a 401", async () => {
		const response = await post(rpc("initialize"), "dgm_nope");
		expect(response.status).toBe(401);
	});

	pgTest(
		"a project that has not turned MCP on refuses and names it",
		async () => {
			const created = await service.createToken(
				{ id: workspaceId, name: "Main" },
				userId,
				"before-enabling",
			);
			const response = await post(rpc("initialize"), created.value);
			expect(response.status).toBe(403);
			const body = (await response.json()) as { error: { message: string } };
			expect(body.error.message).toContain("switched off");
			await service.revokeToken(
				{ id: workspaceId, name: "Main" },
				created.token.id,
			);
		},
	);

	pgTest("a token for another project cannot reach this one", async () => {
		const token = await enable("read-only");
		const response = await post(rpc("initialize"), token, otherWorkspaceId);
		expect(response.status).toBe(404);
	});

	pgTest("initialize briefs the model, mode first", async () => {
		const token = await enable("read-only");
		const response = await post(
			rpc("initialize", { protocolVersion: "2025-03-26" }),
			token,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			result: {
				protocolVersion: string;
				instructions: string;
				capabilities: Record<string, unknown>;
				serverInfo: { name: string };
			};
		};
		// The client asked for a revision; it gets its own back.
		expect(body.result.protocolVersion).toBe("2025-03-26");
		expect(body.result.serverInfo.name).toBe("datagripe/Main");
		expect(body.result.capabilities).toHaveProperty("tools");
		expect(body.result.instructions).toContain("READ-ONLY");
		expect(body.result.instructions).toContain("describe_project");
		// The project's own words, from the conventional workspace file.
		expect(body.result.instructions).toContain("billing.invoices");
	});

	pgTest(
		"an initialized notification is accepted and answered with nothing",
		async () => {
			const token = await enable("read-only");
			const response = await post(
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				token,
			);
			expect(response.status).toBe(202);
		},
	);

	pgTest("tools/list is generated from the schemas", async () => {
		const token = await enable("read-only");
		const response = await post(rpc("tools/list"), token);
		const body = (await response.json()) as {
			result: { tools: Array<{ name: string; inputSchema: unknown }> };
		};
		const names = body.result.tools.map((tool) => tool.name);
		expect(names).toContain("describe_project");
		expect(names).toContain("run_query");
		expect(names).toContain("read_doc");
		expect(body.result.tools[0]?.inputSchema).toBeDefined();
	});

	pgTest(
		"an unknown method is a JSON-RPC error, not a tool error",
		async () => {
			const token = await enable("read-only");
			const response = await post(rpc("resources/subscribe"), token);
			const body = (await response.json()) as { error: { code: number } };
			expect(body.error.code).toBe(-32601);
		},
	);

	pgTest(
		"describe_project answers with the datasources and the files",
		async () => {
			const token = await enable("read-only");
			const { payload, isError } = await callTool(token, "describe_project");
			expect(isError).toBe(false);
			expect(payload?.project).toBe("Main");
			expect(payload?.mode).toBe("read-only");
			const datasources = payload?.datasources as Array<{ ref: string }>;
			expect(datasources[0]?.ref).toBe("predefined:demo");
			const files = payload?.files as Array<{ uri: string }>;
			expect(files[0]?.uri).toContain("datagripe://doc/");
		},
	);

	pgTest(
		"read_doc hands back the markdown source, not a rendering",
		async () => {
			const token = await enable("read-only");
			const { payload } = await callTool(token, "read_doc", {
				uri: "datagripe://doc/11111111-1111-4111-8111-111111111111",
			});
			expect(payload?.text).toContain("# how it fits together");
			expect(payload?.truncated).toBe(false);
		},
	);

	pgTest("search_docs finds where a table is explained", async () => {
		const token = await enable("read-only");
		const { payload } = await callTool(token, "search_docs", {
			text: "authoritative",
		});
		const hits = payload?.hits as Array<{ line: number; label: string }>;
		expect(hits.length).toBe(1);
		expect(hits[0]?.line).toBe(2);
	});

	pgTest("a read runs sandboxed, under the MCP row cap", async () => {
		const token = await enable("read-only");
		runs = [];
		const { payload, isError } = await callTool(token, "run_query", {
			sql: "select 1 as one",
			maxRows: 10_000,
		});
		expect(isError).toBe(false);
		expect(payload?.committed).toBe(false);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.options.sandbox).toBe(true);
		// Asking for more than the cap clamps to it rather than refusing.
		expect(runs[0]?.options.maxRows).toBe(200);
		expect(runs[0]?.options.source).toBe("mcp");
		expect(runs[0]?.options.mcpTokenId).toBeString();
	});

	pgTest("a write is refused before a connection is reserved", async () => {
		const token = await enable("read-only");
		runs = [];
		const { isError, text } = await callTool(token, "run_query", {
			sql: "delete from orders",
		});
		expect(isError).toBe(true);
		expect(text).toContain("read-only");
		expect(text).toContain("mcp panel");
		// The point of layer 1: nothing ran at all.
		expect(runs).toHaveLength(0);
	});

	pgTest("read/write mode commits, and says so", async () => {
		const token = await enable("read-write");
		runs = [];
		const { payload, isError } = await callTool(token, "run_query", {
			sql: "update orders set paid = true",
		});
		expect(isError).toBe(false);
		expect(payload?.committed).toBe(true);
		expect(runs[0]?.options.sandbox).toBe(false);
	});

	pgTest("a viewer's token may read but not commit", async () => {
		const token = await enable("read-write");
		await appDb`
			UPDATE workspace_members SET role = 'viewer'
			WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
		`;
		const write = await callTool(token, "run_query", {
			sql: "update orders set paid = true",
		});
		expect(write.isError).toBe(true);
		expect(write.text).toContain("viewer");
		await appDb`
			UPDATE workspace_members SET role = 'owner'
			WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
		`;
	});

	pgTest(
		"a minter who leaves the project takes their token with them",
		async () => {
			const token = await enable("read-only");
			await appDb`
			DELETE FROM workspace_members
			WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
		`;
			const response = await post(rpc("initialize"), token);
			expect(response.status).toBe(403);
			const body = (await response.json()) as { error: { message: string } };
			expect(body.error.message).toContain("no longer a member");
			await appDb`
			INSERT INTO workspace_members (workspace_id, user_id, role)
			VALUES (${workspaceId}, ${userId}, 'owner')
		`;
		},
	);

	pgTest("a revoked token stops working, and stops being listed", async () => {
		const created = await service.createToken(
			{ id: workspaceId, name: "Main" },
			userId,
			"short-lived",
		);
		const before = await post(rpc("ping"), created.value);
		expect(before.status).toBe(200);
		const state = await service.revokeToken(
			{ id: workspaceId, name: "Main" },
			created.token.id,
		);
		expect(state.tokens.map((entry) => entry.id)).not.toContain(
			created.token.id,
		);
		const after = await post(rpc("ping"), created.value);
		expect(after.status).toBe(401);
	});

	pgTest("the token value is never stored, only its hash", async () => {
		const created = await service.createToken(
			{ id: workspaceId, name: "Main" },
			userId,
			"hash-check",
		);
		const rows = await appDb<Array<{ token_hash: string }>>`
			SELECT token_hash FROM mcp_tokens WHERE id = ${created.token.id}
		`;
		expect(rows[0]?.token_hash).not.toBe(created.value);
		expect(rows[0]?.token_hash).toHaveLength(64);
		expect(created.value.startsWith("dgm_")).toBe(true);
	});

	pgTest("the panel state is what an agent would get", async () => {
		await enable("read-only");
		const state = await service.state({ id: workspaceId, name: "Main" });
		expect(state.available).toBe(true);
		expect(state.enabled).toBe(true);
		expect(state.mode).toBe("read-only");
		expect(state.url).toBe(`http://localhost:3001/mcp/${workspaceId}`);
		expect(state.datasources[0]?.ref).toBe("predefined:demo");
		expect(state.fileCount).toBe(1);
		expect(state.instructionsSource).toContain("AGENTS.md");
	});

	pgTest("a browser origin that is not the app is refused", async () => {
		const token = await enable("read-only");
		const response = await handle(
			new Request(`http://localhost:3001/mcp/${workspaceId}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
					origin: "https://evil.example",
				},
				body: JSON.stringify(rpc("ping")),
			}),
			workspaceId,
		);
		expect(response.status).toBe(403);
	});
});
