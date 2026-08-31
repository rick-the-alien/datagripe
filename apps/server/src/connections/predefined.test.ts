import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	DEFAULT_CONNECTIONS_FILE,
	loadPredefinedConnections,
} from "./predefined";

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "datagripe-predefined-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeConnections(content: unknown): Promise<string> {
	const filePath = path.join(dir, `connections-${crypto.randomUUID()}.json`);
	if (typeof content === "string") {
		await writeFile(filePath, content);
	} else {
		await writeFile(filePath, JSON.stringify(content));
	}
	return filePath;
}

const VALID_ENTRY = {
	id: "local-dev",
	name: "Local Dev Postgres",
	adapter: "postgres",
	host: "localhost",
	port: 5432,
	database: "datagripe",
	username: "datagripe",
	passwordEnv: "TEST_PG_PASSWORD",
	tlsMode: "disable",
	readOnly: true,
	workspaces: ["*"],
};

describe("loadPredefinedConnections", () => {
	test("missing default file yields no predefined connections", async () => {
		if (await Bun.file(DEFAULT_CONNECTIONS_FILE).exists()) {
			// A developer dropped a connections.json at the repo root; the
			// "missing default" path cannot be exercised in this checkout.
			return;
		}
		const entries = await loadPredefinedConnections({
			CONNECTIONS_FILE: undefined,
		});
		expect(entries.size).toBe(0);
	});

	test("missing explicitly configured file fails boot", async () => {
		expect(
			loadPredefinedConnections({
				CONNECTIONS_FILE: path.join(dir, "does-not-exist.json"),
			}),
		).rejects.toThrow("CONNECTIONS_FILE points at a missing file");
	});

	test("loads entries and resolves secrets from the environment", async () => {
		const filePath = await writeConnections({
			connections: [VALID_ENTRY],
		});
		const entries = await loadPredefinedConnections(
			{ CONNECTIONS_FILE: filePath },
			{ TEST_PG_PASSWORD: "s3cret" },
		);
		const entry = entries.get("local-dev");
		expect(entry).toBeDefined();
		expect(entry?.resolved).toMatchObject({
			adapter: "postgres",
			host: "localhost",
			port: 5432,
			database: "datagripe",
			username: "datagripe",
			password: "s3cret",
			tlsMode: "disable",
			readOnly: true,
		});
	});

	test("inline password is accepted (development-only escape hatch)", async () => {
		const filePath = await writeConnections({
			connections: [
				{ ...VALID_ENTRY, passwordEnv: undefined, password: "dev" },
			],
		});
		const entries = await loadPredefinedConnections(
			{ CONNECTIONS_FILE: filePath },
			{},
		);
		expect(entries.get("local-dev")?.resolved.password).toBe("dev");
	});

	test("missing referenced environment variable fails boot with the variable name", async () => {
		const filePath = await writeConnections({
			connections: [VALID_ENTRY],
		});
		expect(
			loadPredefinedConnections({ CONNECTIONS_FILE: filePath }, {}),
		).rejects.toThrow("TEST_PG_PASSWORD is not set");
	});

	test("duplicate ids fail validation", async () => {
		const filePath = await writeConnections({
			connections: [VALID_ENTRY, { ...VALID_ENTRY, name: "Copy" }],
		});
		expect(
			loadPredefinedConnections({ CONNECTIONS_FILE: filePath }, {}),
		).rejects.toThrow("duplicate predefined connection id 'local-dev'");
	});

	test("entry without any password source fails validation", async () => {
		const entry = { ...VALID_ENTRY } as Record<string, unknown>;
		delete entry.passwordEnv;
		const filePath = await writeConnections({ connections: [entry] });
		expect(
			loadPredefinedConnections({ CONNECTIONS_FILE: filePath }, {}),
		).rejects.toThrow("either passwordEnv or password is required");
	});

	test("non-JSON file fails boot", async () => {
		const filePath = await writeConnections("{ not json");
		expect(
			loadPredefinedConnections({ CONNECTIONS_FILE: filePath }),
		).rejects.toThrow("not valid JSON");
	});

	test("non-kebab ids are rejected", async () => {
		const filePath = await writeConnections({
			connections: [{ ...VALID_ENTRY, id: "Local Dev!" }],
		});
		expect(
			loadPredefinedConnections({ CONNECTIONS_FILE: filePath }, {}),
		).rejects.toThrow("kebab-case");
	});
});
