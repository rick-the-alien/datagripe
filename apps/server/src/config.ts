import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
	NODE_ENV: z
		.enum(["development", "test", "production"])
		.default("development"),
	PORT: z.coerce.number().int().min(1).max(65535).default(3001),
	WEB_ORIGIN: z.url().default("http://localhost:5173"),
	/** external: run against APP_DATABASE_URL. embedded: start a managed
	 * PostgreSQL cluster. Default: external when APP_DATABASE_URL is set,
	 * embedded otherwise. Set explicitly to override (e.g. to use embedded
	 * mode while a root .env still defines APP_DATABASE_URL). */
	DATABASE_MODE: z.enum(["embedded", "external"]).optional(),
	APP_DATABASE_URL: z.string().min(1).optional(),
	/** Data directory for the embedded PostgreSQL cluster. */
	EMBEDDED_PG_DATA_DIR: z.string().min(1).default("./data/pg"),
	/** Embedded PostgreSQL port; 0 picks a free port at startup. */
	EMBEDDED_PG_PORT: z.coerce.number().int().min(0).max(65535).default(0),
	/** Explicitly toggle account auth. Default: off in embedded mode
	 * (direct-in personal use), on in external mode. */
	AUTH_DISABLED: z
		.enum(["true", "false"])
		.optional()
		.transform((value) => (value === undefined ? undefined : value === "true")),
	/** Required in external mode. In embedded mode, missing secrets are
	 * generated once and persisted next to the data directory. */
	CONNECTION_ENCRYPTION_KEY: z.string().min(32).optional(),
	SESSION_SECRET: z.string().min(32).optional(),
	/** Optional directory of built web assets to serve (single-binary and
	 * desktop deployments); unset while developing against the vite server. */
	WEB_STATIC_DIR: z.string().min(1).optional(),
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

type EnvConfig = z.infer<typeof envSchema>;

export interface AppConfig
	extends Omit<
		EnvConfig,
		"AUTH_DISABLED" | "CONNECTION_ENCRYPTION_KEY" | "SESSION_SECRET"
	> {
	/** external: APP_DATABASE_URL was provided. embedded: the server starts
	 * and manages its own PostgreSQL cluster (EMBEDDED_PG_*). */
	DATABASE_MODE: "embedded" | "external";
	/** Resolved: explicit env wins; otherwise off for embedded, on for
	 * external. When true there are no accounts — the session is implicit. */
	AUTH_DISABLED: boolean;
	CONNECTION_ENCRYPTION_KEY: string;
	SESSION_SECRET: string;
	/** Embedded cluster superuser password (generated with the local
	 * secrets); only meaningful in embedded mode. */
	EMBEDDED_PG_PASSWORD: string | undefined;
}

const REPO_ROOT = path.join(import.meta.dir, "../../..");

/**
 * Bun only auto-loads `.env` from the process cwd. DataGripe keeps one
 * `.env` at the repository root, so merge it for keys the environment
 * does not already define. Real environment variables always win.
 */
async function mergeRootEnvFile(
	env: Record<string, string | undefined>,
): Promise<Record<string, string | undefined>> {
	const rootEnvPath = path.join(REPO_ROOT, ".env");
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

/** Resolve a configured path against the repository root. */
export function resolveRepoPath(configured: string): string {
	return path.isAbsolute(configured)
		? configured
		: path.join(REPO_ROOT, configured);
}

interface LocalSecrets {
	connectionEncryptionKey: string;
	sessionSecret: string;
	embeddedPgPassword: string;
}

/**
 * Load the local secrets file, or generate one (mode 0600). Keeps
 * embedded mode zero-config while secrets stay stable across restarts —
 * connection passwords are encrypted at rest with the
 * connectionEncryptionKey, so losing it would orphan them. The file lives
 * BESIDE the cluster directory, never inside it: initdb requires the
 * cluster directory to be empty on first boot.
 */
async function loadOrCreateLocalSecrets(
	dataDir: string,
): Promise<LocalSecrets> {
	const secretsPath = path.join(
		path.dirname(dataDir),
		"datagripe.secrets.json",
	);
	try {
		const raw = await readFile(secretsPath, "utf8");
		const parsed = JSON.parse(raw) as Partial<LocalSecrets>;
		if (
			typeof parsed.connectionEncryptionKey === "string" &&
			parsed.connectionEncryptionKey.length >= 32 &&
			typeof parsed.sessionSecret === "string" &&
			parsed.sessionSecret.length >= 32 &&
			typeof parsed.embeddedPgPassword === "string" &&
			parsed.embeddedPgPassword.length >= 16
		) {
			return parsed as LocalSecrets;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(
				`Local secrets file ${secretsPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	await mkdir(path.dirname(secretsPath), { recursive: true });
	const generated: LocalSecrets = {
		connectionEncryptionKey: randomBytes(32).toString("base64url"),
		sessionSecret: randomBytes(32).toString("base64url"),
		embeddedPgPassword: randomBytes(24).toString("base64url"),
	};
	await writeFile(secretsPath, `${JSON.stringify(generated, null, 2)}\n`, {
		mode: 0o600,
	});
	return generated;
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
	const parsed = result.data;
	const databaseMode =
		parsed.DATABASE_MODE ??
		(parsed.APP_DATABASE_URL === undefined ? "embedded" : "external");

	if (databaseMode === "external") {
		const missing: string[] = [];
		if (parsed.APP_DATABASE_URL === undefined) {
			missing.push("APP_DATABASE_URL");
		}
		if (parsed.CONNECTION_ENCRYPTION_KEY === undefined) {
			missing.push("CONNECTION_ENCRYPTION_KEY");
		}
		if (parsed.SESSION_SECRET === undefined) {
			missing.push("SESSION_SECRET");
		}
		if (missing.length > 0) {
			throw new Error(
				`Invalid server configuration:\n  ${missing.join(", ")}: required in external mode`,
			);
		}
		return {
			...parsed,
			DATABASE_MODE: databaseMode,
			AUTH_DISABLED: parsed.AUTH_DISABLED ?? false,
			CONNECTION_ENCRYPTION_KEY: parsed.CONNECTION_ENCRYPTION_KEY as string,
			SESSION_SECRET: parsed.SESSION_SECRET as string,
			EMBEDDED_PG_PASSWORD: undefined,
		};
	}

	const local = await loadOrCreateLocalSecrets(
		resolveRepoPath(parsed.EMBEDDED_PG_DATA_DIR),
	);
	return {
		...parsed,
		DATABASE_MODE: databaseMode,
		AUTH_DISABLED: parsed.AUTH_DISABLED ?? true,
		CONNECTION_ENCRYPTION_KEY:
			parsed.CONNECTION_ENCRYPTION_KEY ?? local.connectionEncryptionKey,
		SESSION_SECRET: parsed.SESSION_SECRET ?? local.sessionSecret,
		EMBEDDED_PG_PASSWORD: local.embeddedPgPassword,
	};
}
