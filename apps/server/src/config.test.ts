import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "./config";

const noEnvFile = { envFile: false } as const;

const tempDirs: string[] = [];

async function tempDataDir(): Promise<string> {
	// The secrets file lands BESIDE the cluster directory, so hand config a
	// "pg" subdirectory to keep everything inside the cleaned-up temp dir.
	const dir = await mkdtemp(path.join(tmpdir(), "datagripe-config-test-"));
	tempDirs.push(dir);
	return path.join(dir, "pg");
}

afterAll(async () => {
	await Promise.all(
		tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

const validEnv = {
	APP_DATABASE_URL: "postgres://datagripe:datagripe@localhost:5432/datagripe",
	CONNECTION_ENCRYPTION_KEY: "a".repeat(32),
	SESSION_SECRET: "b".repeat(32),
};

describe("loadConfig", () => {
	test("applies documented defaults", async () => {
		const config = await loadConfig(validEnv, noEnvFile);
		expect(config.PORT).toBe(3001);
		expect(config.QUERY_TIMEOUT_MS).toBe(30_000);
		expect(config.QUERY_MAX_ROWS).toBe(10_000);
		expect(config.MAX_CONCURRENT_QUERIES_PER_USER).toBe(3);
	});

	test("external mode requires both secrets", async () => {
		await expect(
			loadConfig({ APP_DATABASE_URL: validEnv.APP_DATABASE_URL }, noEnvFile),
		).rejects.toThrow(/CONNECTION_ENCRYPTION_KEY/);
		await expect(
			loadConfig(
				{
					APP_DATABASE_URL: validEnv.APP_DATABASE_URL,
					CONNECTION_ENCRYPTION_KEY: "a".repeat(32),
				},
				noEnvFile,
			),
		).rejects.toThrow(/SESSION_SECRET/);
	});

	test("no APP_DATABASE_URL selects embedded mode with auth disabled", async () => {
		const dataDir = await tempDataDir();
		const config = await loadConfig(
			{ EMBEDDED_PG_DATA_DIR: dataDir },
			noEnvFile,
		);
		expect(config.DATABASE_MODE).toBe("embedded");
		expect(config.AUTH_DISABLED).toBe(true);
		expect(config.APP_DATABASE_URL).toBeUndefined();
		// Secrets are generated and persisted next to the data directory.
		expect(config.CONNECTION_ENCRYPTION_KEY.length).toBeGreaterThanOrEqual(32);
		expect(config.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
		expect(config.EMBEDDED_PG_PASSWORD).toBeDefined();
		const secrets = JSON.parse(
			await Bun.file(
				path.join(path.dirname(dataDir), "datagripe.secrets.json"),
			).text(),
		);
		expect(secrets.connectionEncryptionKey).toBe(
			config.CONNECTION_ENCRYPTION_KEY,
		);
	});

	test("generated embedded secrets are stable across loads", async () => {
		const dataDir = await tempDataDir();
		const first = await loadConfig(
			{ EMBEDDED_PG_DATA_DIR: dataDir },
			noEnvFile,
		);
		const second = await loadConfig(
			{ EMBEDDED_PG_DATA_DIR: dataDir },
			noEnvFile,
		);
		expect(second.CONNECTION_ENCRYPTION_KEY).toBe(
			first.CONNECTION_ENCRYPTION_KEY,
		);
		expect(second.EMBEDDED_PG_PASSWORD).toBe(first.EMBEDDED_PG_PASSWORD);
	});

	test("explicit AUTH_DISABLED wins over the mode default", async () => {
		const embedded = await loadConfig(
			{
				EMBEDDED_PG_DATA_DIR: await tempDataDir(),
				AUTH_DISABLED: "false",
			},
			noEnvFile,
		);
		expect(embedded.AUTH_DISABLED).toBe(false);
		const external = await loadConfig(
			{ ...validEnv, AUTH_DISABLED: "true" },
			noEnvFile,
		);
		expect(external.AUTH_DISABLED).toBe(true);
	});

	test("APP_DATABASE_URL selects external mode with auth enabled", async () => {
		const config = await loadConfig(validEnv, noEnvFile);
		expect(config.DATABASE_MODE).toBe("external");
		expect(config.AUTH_DISABLED).toBe(false);
		expect(config.EMBEDDED_PG_PASSWORD).toBeUndefined();
	});

	test("explicit DATABASE_MODE wins over APP_DATABASE_URL presence", async () => {
		const embedded = await loadConfig(
			{
				...validEnv,
				DATABASE_MODE: "embedded",
				EMBEDDED_PG_DATA_DIR: await tempDataDir(),
			},
			noEnvFile,
		);
		expect(embedded.DATABASE_MODE).toBe("embedded");
		expect(embedded.AUTH_DISABLED).toBe(true);
		await expect(
			loadConfig({ DATABASE_MODE: "external" }, noEnvFile),
		).rejects.toThrow(/APP_DATABASE_URL/);
	});

	test("rejects weak secrets shorter than 32 chars", async () => {
		await expect(
			loadConfig(
				{ ...validEnv, CONNECTION_ENCRYPTION_KEY: "short" },
				noEnvFile,
			),
		).rejects.toThrow(/CONNECTION_ENCRYPTION_KEY/);
		await expect(
			loadConfig({ ...validEnv, SESSION_SECRET: "short" }, noEnvFile),
		).rejects.toThrow(/SESSION_SECRET/);
	});

	test("coerces numeric strings", async () => {
		const config = await loadConfig(
			{ ...validEnv, PORT: "4000", QUERY_MAX_ROWS: "500" },
			noEnvFile,
		);
		expect(config.PORT).toBe(4000);
		expect(config.QUERY_MAX_ROWS).toBe(500);
	});

	test("rejects out-of-range port", async () => {
		await expect(
			loadConfig({ ...validEnv, PORT: "70000" }, noEnvFile),
		).rejects.toThrow(/PORT/);
	});
});
