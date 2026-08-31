import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresAdapter } from "@datagripe/database-adapters";
import { SQL } from "bun";
import { ensureLocalWorkspace } from "../bootstrap";
import { createKeyring } from "../crypto/keyring";
import { withIdempotency } from "../db/app/idempotency";
import { migrate } from "../db/app/migrate";
import type { AppDb } from "../db/app/pool";
import type { PredefinedEntry } from "./predefined";
import { type ConnectionsService, createConnectionsService } from "./service";

/**
 * Integration test against a real PostgreSQL app database (CI service or
 * local container). Creates/migrates a scratch database; skipped when no
 * server is reachable.
 */

const ADMIN_URL =
	Bun.env.APP_TEST_ADMIN_URL ??
	"postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_service_test";

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
let service: ConnectionsService;
let workspace: { id: string; name: string };
const adapter = new PostgresAdapter();

const PREDEFINED: PredefinedEntry = {
	definition: {
		id: "local-dev",
		name: "Local Dev Postgres",
		adapter: "postgres",
		host: "localhost",
		port: 5432,
		database: "postgres",
		username: "datagripe",
		passwordEnv: "DEV_PG_PASSWORD",
		tlsMode: "disable",
		readOnly: true,
		workspaces: ["*"],
	},
	resolved: {
		adapter: "postgres",
		host: "localhost",
		port: 5432,
		database: "postgres",
		username: "datagripe",
		password: "datagripe",
		tlsMode: "disable",
		readOnly: true,
	},
	loadedAt: new Date().toISOString(),
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
	// Deterministic contents for every run.
	await appDb.unsafe(`
		TRUNCATE idempotency_keys, connection_secrets, connections,
			documents, workspace_layouts, query_executions,
			workspace_members, workspaces, users CASCADE
	`);
	workspace = (await ensureLocalWorkspace(appDb)).workspace;
	service = createConnectionsService({
		appDb,
		keyring: createKeyring(new Map([[1, "service-test-key-0123456789abcdef"]])),
		adapter,
		predefined: new Map([[PREDEFINED.definition.id, PREDEFINED]]),
		ssrf: { assertHostAllowed: async () => {} },
	});
});

afterAll(async () => {
	await adapter.close();
	await appDb?.close();
});

const CREATE_REQUEST = {
	name: "Test PG",
	adapter: "postgres" as const,
	host: "localhost",
	port: 5432,
	databaseName: "postgres",
	username: "datagripe",
	password: "super-secret-pw",
	tlsMode: "disable" as const,
	readOnly: true,
	idempotencyKey: "test-key-0001",
};

describe("connections service", () => {
	pgTest("create stores ciphertext, returns safe metadata", async () => {
		const created = await service.createConnection(workspace, CREATE_REQUEST);
		expect(created).toMatchObject({
			name: "Test PG",
			source: "managed",
			databaseName: "postgres",
			readOnly: true,
		});
		expect(created).not.toHaveProperty("password");

		const secrets = await appDb<
			{ ciphertext: Buffer; key_version: number }[]
		>`SELECT ciphertext, key_version FROM connection_secrets WHERE connection_id = ${created.id}`;
		expect(secrets).toHaveLength(1);
		const row = secrets[0];
		expect(row).toBeDefined();
		expect(row?.ciphertext.toString("utf8")).not.toContain("super-secret-pw");
		expect(row?.key_version).toBe(1);
	});

	pgTest("list returns managed and predefined, never secrets", async () => {
		const list = await service.listConnections(workspace);
		expect(list.length).toBeGreaterThanOrEqual(2);
		const predefined = list.find((c) => c.id === "local-dev");
		expect(predefined).toMatchObject({ source: "predefined" });
		for (const connection of list) {
			expect(JSON.stringify(connection)).not.toContain("super-secret-pw");
			expect(connection).not.toHaveProperty("password");
		}
	});

	pgTest("update changes fields and re-encrypts a new password", async () => {
		const [before] = await service.listConnections(workspace);
		const managed = await service.listConnections(workspace);
		const target = managed.find((c) => c.source === "managed");
		expect(target).toBeDefined();
		if (target === undefined) {
			return;
		}
		const oldSecret = await appDb<{ ciphertext: Buffer }[]>`
			SELECT ciphertext FROM connection_secrets WHERE connection_id = ${target.id}
		`;

		const updated = await service.updateConnection(workspace, {
			id: target.id,
			name: "Renamed PG",
			password: "new-secret-pw-2",
			idempotencyKey: "test-key-0002",
		});
		expect(updated.name).toBe("Renamed PG");
		expect(updated.host).toBe(target?.host ?? before?.host);

		const newSecret = await appDb<{ ciphertext: Buffer }[]>`
			SELECT ciphertext FROM connection_secrets WHERE connection_id = ${target.id}
		`;
		expect(
			newSecret[0]?.ciphertext.equals(
				oldSecret[0]?.ciphertext ?? Buffer.from([]),
			),
		).toBe(false);
	});

	pgTest("predefined connections reject mutations", async () => {
		await expect(
			service.updateConnection(workspace, {
				id: "local-dev",
				name: "Hacked",
				idempotencyKey: "test-key-0003",
			}),
		).rejects.toMatchObject({ code: "CONNECTION_READ_ONLY" });
		await expect(
			service.deleteConnection(workspace, "local-dev"),
		).rejects.toMatchObject({
			code: "CONNECTION_READ_ONLY",
		});
	});

	pgTest(
		"testConnection works for drafts, managed, and predefined",
		async () => {
			const draft = await service.testConnection(workspace, {
				draft: {
					name: "Draft",
					adapter: "postgres",
					host: "localhost",
					port: 5432,
					databaseName: "postgres",
					username: "datagripe",
					password: "datagripe",
					tlsMode: "disable",
					readOnly: true,
				},
			});
			expect(draft.ok).toBe(true);

			const managed = (await service.listConnections(workspace)).find(
				(c) => c.source === "managed",
			);
			if (managed !== undefined) {
				const byId = await service.testConnection(workspace, {
					connectionId: managed.id,
				});
				expect(byId.ok).toBe(true);
			}

			const predefined = await service.testConnection(workspace, {
				connectionId: "local-dev",
			});
			expect(predefined.ok).toBe(true);
		},
	);

	pgTest("schema.children introspects and caches", async () => {
		const nodes = await service.schemaChildren(
			workspace,
			"local-dev",
			[],
			false,
		);
		expect(nodes.some((node) => node.kind === "schema")).toBe(true);

		const cached = await service.schemaChildren(
			workspace,
			"local-dev",
			[],
			false,
		);
		expect(cached).toBe(nodes);

		const refreshed = await service.schemaChildren(
			workspace,
			"local-dev",
			[],
			true,
		);
		expect(refreshed).not.toBe(nodes);
		expect(refreshed).toEqual(nodes);
	});

	pgTest("delete removes connection and secret", async () => {
		const managed = (await service.listConnections(workspace)).find(
			(c) => c.source === "managed",
		);
		expect(managed).toBeDefined();
		if (managed === undefined) {
			return;
		}
		await service.deleteConnection(workspace, managed.id);
		const connections = await appDb`
			SELECT id FROM connections WHERE id = ${managed.id}
		`;
		const secrets = await appDb`
			SELECT connection_id FROM connection_secrets WHERE connection_id = ${managed.id}
		`;
		expect(connections).toHaveLength(0);
		expect(secrets).toHaveLength(0);
	});

	pgTest(
		"idempotency replays the stored response without re-running",
		async () => {
			let runs = 0;
			const fn = async () => {
				runs++;
				return { value: "created-once" };
			};
			const first = await withIdempotency(
				appDb,
				workspace.id,
				"connection.create",
				"idem-test-key",
				fn,
			);
			const second = await withIdempotency(
				appDb,
				workspace.id,
				"connection.create",
				"idem-test-key",
				fn,
			);
			expect(first).toEqual({ value: "created-once" });
			expect(second).toEqual(first);
			expect(runs).toBe(1);
		},
	);
});
