import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { type AppConfig, resolveRepoPath } from "../../config";
import { log } from "../../log";

export interface EmbeddedPgHandle {
	/** Connection URL for the app pool. */
	url: string;
	stop: () => Promise<void>;
}

function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = net.createServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		if (address === null || typeof address === "string") {
			probe.close();
			reject(new Error("Failed to allocate a free port"));
			return;
		}
		probe.close(() => resolve(address.port));
	});
	return promise;
}

/**
 * Start the embedded PostgreSQL cluster (zero-config local mode). The
 * cluster is a real postgres initialised on first boot under
 * EMBEDDED_PG_DATA_DIR, so every query, migration, and type behaves
 * exactly as in external mode.
 */
export async function startEmbeddedPostgres(
	config: AppConfig,
): Promise<EmbeddedPgHandle> {
	if (config.EMBEDDED_PG_PASSWORD === undefined) {
		throw new Error("Embedded mode requires generated local secrets");
	}
	const password = config.EMBEDDED_PG_PASSWORD;
	const dataDir = resolveRepoPath(config.EMBEDDED_PG_DATA_DIR);
	await mkdir(dataDir, { recursive: true });
	const port =
		config.EMBEDDED_PG_PORT === 0 ? await freePort() : config.EMBEDDED_PG_PORT;

	const pg = new EmbeddedPostgres({
		databaseDir: dataDir,
		user: "datagripe",
		password,
		port,
		authMethod: "scram-sha-256",
		persistent: true,
		onLog: (message) =>
			log.debug("embedded-postgres", { output: String(message).trim() }),
		onError: (message) =>
			log.warn("embedded-postgres", { output: String(message).trim() }),
	});

	if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
		log.info("initialising embedded postgres cluster", { dataDir });
		await pg.initialise();
	}
	await pg.start();
	log.info("embedded postgres started", { port, dataDir });

	return {
		url: `postgres://datagripe:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`,
		stop: () => pg.stop(),
	};
}
