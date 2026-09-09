import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
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
 * A postmaster already serving this data directory, if there is one.
 *
 * `postmaster.pid` is postgres's own lock file: line 1 is the postmaster
 * pid and line 4 is the port it listens on. Postgres clears the file
 * itself when the pid is dead, so the only case that reaches here is a
 * cluster that really is up — one this process did not start, left behind
 * by a desktop app that was killed rather than closed.
 *
 * Adopting it beats refusing to start. The alternative is what people
 * actually hit: quit the app in a way that skipped the shutdown, and it
 * never opens again, because the thing standing in its way is its own
 * database.
 */
async function adoptRunningCluster(
	dataDir: string,
	password: string,
): Promise<EmbeddedPgHandle | null> {
	const pidFile = path.join(dataDir, "postmaster.pid");
	let lines: string[];
	try {
		lines = (await readFile(pidFile, "utf8")).split("\n");
	} catch {
		return null;
	}
	const pid = Number(lines[0]);
	const port = Number(lines[3]);
	if (
		!Number.isInteger(pid) ||
		pid <= 0 ||
		!Number.isInteger(port) ||
		port <= 0
	) {
		return null;
	}
	try {
		// Signal 0 tests for the process without touching it.
		process.kill(pid, 0);
	} catch {
		return null;
	}

	log.warn("adopting a postgres cluster that was already running", {
		pid,
		port,
		dataDir,
	});

	let stopped = false;
	// SIGINT is postgres's fast shutdown, the same signal `pg_ctl -m fast`
	// sends: roll back what is open and go, rather than SIGTERM's smart
	// shutdown, which waits for clients that may never disconnect.
	const stop = (): void => {
		if (stopped) {
			return;
		}
		stopped = true;
		try {
			process.kill(pid, "SIGINT");
		} catch {
			// Gone already.
		}
	};

	// `embedded-postgres` installs an exit hook for the clusters it starts,
	// which is the only reason an ungraceful shutdown does not normally
	// strand one. An adopted cluster has no such instance behind it, so it
	// needs the same guarantee — and a signal is cheap enough to send from
	// an exit handler, where nothing may be awaited.
	process.once("exit", stop);

	return {
		url: `postgres://datagripe:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`,
		stop: async () => stop(),
	};
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

	const adopted = await adoptRunningCluster(dataDir, password);
	if (adopted !== null) {
		return adopted;
	}

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
