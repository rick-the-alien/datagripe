import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../config";
import { log } from "../../log";
import { type AppDb, createAppDb } from "./pool";

const MIGRATIONS_DIR = path.join(import.meta.dir, "../../../migrations");

async function ensureMigrationsTable(db: AppDb): Promise<void> {
	await db`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

async function appliedMigrations(db: AppDb): Promise<Set<string>> {
	const rows = await db`SELECT name FROM schema_migrations`;
	return new Set(rows.map((row: { name: string }) => row.name));
}

export async function listMigrationFiles(
	dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
	const entries = await readdir(dir);
	return entries.filter((name) => name.endsWith(".sql")).sort();
}

/**
 * Apply pending migrations in filename order. Each migration runs in a
 * transaction and is recorded in schema_migrations.
 */
export async function migrate(db: AppDb): Promise<string[]> {
	await ensureMigrationsTable(db);
	const applied = await appliedMigrations(db);
	const files = await listMigrationFiles();
	const newlyApplied: string[] = [];

	for (const file of files) {
		if (applied.has(file)) {
			continue;
		}
		const sql = await Bun.file(path.join(MIGRATIONS_DIR, file)).text();
		await db.begin(async (tx) => {
			await tx.unsafe(sql);
			await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
		});
		newlyApplied.push(file);
		log.info("migration applied", { migration: file });
	}
	return newlyApplied;
}

// Run directly: `bun run src/db/app/migrate.ts`
if (import.meta.main) {
	const config = await loadConfig();
	if (config.APP_DATABASE_URL === undefined) {
		throw new Error(
			"db:migrate targets an external database (APP_DATABASE_URL). Embedded mode migrates automatically at server startup.",
		);
	}
	const db = createAppDb(config.APP_DATABASE_URL);
	try {
		const applied = await migrate(db);
		if (applied.length === 0) {
			log.info("database already up to date");
		}
	} finally {
		await db.close();
	}
}
