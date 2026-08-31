import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const noEnvFile = { envFile: false } as const;

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

	test("rejects missing APP_DATABASE_URL", async () => {
		await expect(
			loadConfig(
				{
					CONNECTION_ENCRYPTION_KEY: "a".repeat(32),
					SESSION_SECRET: "b".repeat(32),
				},
				noEnvFile,
			),
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
