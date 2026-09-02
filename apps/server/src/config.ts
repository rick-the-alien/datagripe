import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
	NODE_ENV: z
		.enum(["development", "test", "production"])
		.default("development"),
	PORT: z.coerce.number().int().min(1).max(65535).default(3001),
	WEB_ORIGIN: z.url().default("http://localhost:5173"),
	APP_DATABASE_URL: z.string().min(1),
	CONNECTION_ENCRYPTION_KEY: z.string().min(32),
	SESSION_SECRET: z.string().min(32),
	/** Predefined connections file; defaults to connections.json at repo root. */
	CONNECTIONS_FILE: z.string().min(1).optional(),
	/** Allow account signup after the bootstrap user exists. */
	ALLOW_SIGNUP: z
		.enum(["true", "false"])
		.default("false")
		.transform((value) => value === "true"),
	/** Comma-separated hostnames allowed despite SSRF private-range blocks. */
	TARGET_HOST_ALLOWLIST: z.string().default(""),
	/** Disable SSRF target-host blocking entirely (trusted-network deployments). */
	SSRF_DISABLED: z
		.enum(["true", "false"])
		.default("false")
		.transform((value) => value === "true"),
	QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
	QUERY_MAX_ROWS: z.coerce.number().int().positive().default(10_000),
	QUERY_MAX_BYTES: z.coerce.number().int().positive().default(25_000_000),
	MAX_CONCURRENT_QUERIES_PER_USER: z.coerce
		.number()
		.int()
		.positive()
		.default(3),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Bun only auto-loads `.env` from the process cwd. DataGripe keeps one
 * `.env` at the repository root, so merge it for keys the environment
 * does not already define. Real environment variables always win.
 */
async function mergeRootEnvFile(
	env: Record<string, string | undefined>,
): Promise<Record<string, string | undefined>> {
	const rootEnvPath = path.join(import.meta.dir, "../../../.env");
	const file = Bun.file(rootEnvPath);
	if (!(await file.exists())) {
		return env;
	}
	const merged = { ...env };
	for (const line of (await file.text()).split("\n")) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
		if (!match || line.trimStart().startsWith("#")) {
			continue;
		}
		const [, key, rawValue] = match;
		if (
			key !== undefined &&
			rawValue !== undefined &&
			merged[key] === undefined
		) {
			merged[key] = rawValue.replace(/^["']|["']$/g, "");
		}
	}
	return merged;
}

export interface LoadConfigOptions {
	/** Merge the repository-root `.env` for missing keys (default true). */
	envFile?: boolean;
}

/**
 * Parse and validate process environment. Throws with a readable
 * message listing every invalid/missing variable.
 */
export async function loadConfig(
	env: Record<string, string | undefined> = Bun.env,
	options: LoadConfigOptions = {},
): Promise<AppConfig> {
	const source = options.envFile === false ? env : await mergeRootEnvFile(env);
	const result = envSchema.safeParse(source);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new Error(`Invalid server configuration:\n${issues}`);
	}
	return result.data;
}
