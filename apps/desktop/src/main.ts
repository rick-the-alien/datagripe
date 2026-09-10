import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { app, BrowserWindow, Utils } from "electrobun/main";
import { applyRenderingSettings, readSettings } from "./rendering";
import { scheduleUpdateChecks } from "./updates";

/**
 * DataGripe desktop shell: spawns the DataGripe server in embedded,
 * direct-in mode (managed postgres, no accounts) with its data under the
 * OS app-data dir, then loads it in a frameless window. The header of the
 * web app doubles as the window drag region (app-region CSS in the web
 * app), so no native titlebar is wasted.
 *
 * Backend selection, first match wins:
 * - DATAGRIPE_SERVER_CMD / DATAGRIPE_SERVER_CMD_ARGS: full custom command.
 * - DATAGRIPE_SERVER_ENTRY: absolute path to a server entry point.
 * - a checkout above this bundle, run from source — this is what
 *   `hutch electrobun dev` gets, so changing the server stays a restart
 *   rather than a rebuild.
 * - the backend staged into `Resources/app/server` by
 *   `scripts/bundle-server.ts`, which is what a packaged build ships.
 */

/** What runs a server entry point from source; the shell's own runtime
 * for the bundled one. A packaged install has no `bun` on its PATH. */
const runtime = Bun.env.DATAGRIPE_SERVER_RUNTIME ?? "bun";

interface Backend {
	command: string[];
	cwd: string;
	/** Built web app for the server to serve, when we know where it is. */
	webStaticDir?: string;
	/** Migrations to apply at boot, when they are not in a checkout. */
	migrationsDir?: string;
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

/** Walk up from the bundle directory looking for a DataGripe checkout. */
function checkoutBackend(): Backend | null {
	let dir = import.meta.dir;
	// Dev bundles run from build/<env>/DataGripe-dev/Resources/app/bun —
	// eight levels below the repo root.
	for (let depth = 0; depth < 12; depth += 1) {
		const entry = path.join(dir, "apps/server/src/index.ts");
		if (existsSync(entry)) {
			return {
				command: [runtime, "run", entry],
				cwd: path.join(dir, "apps/server"),
				webStaticDir: path.join(dir, "apps/web/dist"),
			};
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return null;
}

/**
 * The backend a packaged build ships: the bundled server, its migrations,
 * the built web app and the PostgreSQL binaries, all under
 * `Resources/app/server` (see `scripts/bundle-server.ts`). This module
 * runs from `Resources/app/bun`.
 */
function bundledBackend(): Backend | null {
	const dir = path.join(import.meta.dir, "../server");
	const entry = path.join(dir, "index.js");
	if (!existsSync(entry)) {
		return null;
	}
	return {
		// The shell's own runtime, not `bun`: a packaged install has one
		// Bun on disk and this is it.
		command: [process.execPath, entry],
		cwd: dir,
		webStaticDir: path.join(dir, "web"),
		migrationsDir: path.join(dir, "migrations"),
	};
}

function resolveBackend(): Backend {
	const customCmd = Bun.env.DATAGRIPE_SERVER_CMD;
	if (customCmd !== undefined) {
		return {
			command: [
				customCmd,
				...(Bun.env.DATAGRIPE_SERVER_CMD_ARGS?.split(" ") ?? []),
			],
			cwd: Bun.env.DATAGRIPE_SERVER_CWD ?? process.cwd(),
		};
	}
	const override = Bun.env.DATAGRIPE_SERVER_ENTRY;
	if (override !== undefined) {
		return {
			command: [runtime, "run", override],
			cwd: path.dirname(override),
		};
	}
	const backend = checkoutBackend() ?? bundledBackend();
	if (backend === null) {
		throw new Error(
			`No DataGripe server to run: no checkout above ${import.meta.dir}, and no bundled server at ${path.join(import.meta.dir, "../server/index.js")}. Set DATAGRIPE_SERVER_ENTRY or DATAGRIPE_SERVER_CMD.`,
		);
	}
	return backend;
}

async function waitForServer(port: number): Promise<void> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://localhost:${port}/health`);
			if (res.ok) {
				return;
			}
		} catch {
			// Server not up yet; keep waiting.
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`DataGripe server did not become healthy on port ${port}`);
}

const port = Number(Bun.env.DATAGRIPE_PORT ?? (await freePort()));
const origin = `http://localhost:${port}`;
const userData = Utils.paths.userData;
const backend = resolveBackend();

// The desktop shell is the personal, direct-in deployment: embedded
// postgres under the OS app-data dir, no accounts. Explicit environment
// variables (DATABASE_MODE/APP_DATABASE_URL/AUTH_DISABLED) still win.
const serverEnv: Record<string, string | undefined> = {
	...process.env,
	DATABASE_MODE: Bun.env.DATABASE_MODE ?? "embedded",
	EMBEDDED_PG_DATA_DIR:
		Bun.env.EMBEDDED_PG_DATA_DIR ?? path.join(userData, "pg"),
	AUTH_DISABLED: Bun.env.AUTH_DISABLED ?? "true",
	PORT: String(port),
	WEB_ORIGIN: origin,
	NODE_ENV: Bun.env.NODE_ENV ?? "production",
};
// Left alone when neither the environment nor the backend names one, so
// the server keeps its own defaults rather than being handed "undefined".
for (const [key, value] of [
	["WEB_STATIC_DIR", Bun.env.WEB_STATIC_DIR ?? backend.webStaticDir],
	["MIGRATIONS_DIR", Bun.env.MIGRATIONS_DIR ?? backend.migrationsDir],
] as const) {
	if (value !== undefined) {
		serverEnv[key] = value;
	}
}

console.log(
	`[desktop] starting server: ${backend.command.join(" ")} (cwd ${backend.cwd})`,
);
const server = Bun.spawn(backend.command, {
	cwd: backend.cwd,
	env: serverEnv,
	stdout: "inherit",
	stderr: "inherit",
});

function stopServer(): void {
	try {
		server.kill("SIGTERM");
	} catch {
		// Already exited.
	}
}

/**
 * Stop the server and wait for it to go, so that whatever happens next
 * does not race the embedded PostgreSQL's lock on its data directory.
 * Bounded: a backend that will not exit should not strand the caller.
 */
async function stopServerAndWait(timeoutMs = 15_000): Promise<void> {
	stopServer();
	await Promise.race([
		server.exited,
		new Promise((resolve) => setTimeout(resolve, timeoutMs)),
	]);
}
process.on("exit", stopServer);
process.on("SIGINT", () => {
	stopServer();
	process.exit(0);
});
process.on("SIGTERM", () => {
	stopServer();
	process.exit(0);
});
// Closing the window does not go through any of those. Electrobun quits
// natively, and the process ends without Bun running an exit handler — so
// the server outlived the app that spawned it, and with it the embedded
// PostgreSQL holding the data directory. The next launch then could not
// start its own, and the app never opened again.
//
// `before-quit` is the one hook every quit path passes through: the window
// closing, `Utils.quit`, and the updater's handoff. Handlers are called
// synchronously and shutdown proceeds without waiting, so this signals and
// does not block; the native quit allows five seconds, which is longer
// than the server needs to stop a local cluster.
app.on("before-quit", () => stopServer());

await waitForServer(port);
console.log(`[desktop] server healthy on ${origin}`);

// Before the first window: WebKit reads its rendering environment when it
// builds a backing store, and on some Linux GPU setups the default one
// cannot allocate — see `rendering.ts`.
applyRenderingSettings(readSettings(userData));

new BrowserWindow({
	title: "DataGripe",
	url: origin,
	titleBarStyle: "hidden",
	frame: {
		width: 1440,
		height: 900,
	},
});

scheduleUpdateChecks({ stopServer: stopServerAndWait });
