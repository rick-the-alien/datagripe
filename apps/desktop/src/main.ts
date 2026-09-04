import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { BrowserWindow, Utils } from "electrobun/main";

/**
 * DataGripe desktop shell: spawns the monorepo server in embedded,
 * direct-in mode (managed postgres, no accounts) with its data under the
 * OS app-data dir, then loads it in a frameless window. The header of the
 * web app doubles as the window drag region (app-region CSS in the web
 * app), so no native titlebar is wasted.
 *
 * Backend selection:
 * - DATAGRIPE_SERVER_ENTRY: absolute path to the server entry (default:
 *   discovered upward from this bundle as apps/server/src/index.ts).
 * - DATAGRIPE_SERVER_CMD / DATAGRIPE_SERVER_CMD_ARGS: full custom command.
 */

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

/** Walk up from the bundle directory looking for the monorepo server. */
function findServerEntry(): { entry: string; cwd: string } {
	let dir = import.meta.dir;
	// Dev bundles run from build/<env>/DataGripe-dev/Resources/app/bun —
	// eight levels below the repo root; packaged builds may nest deeper.
	for (let depth = 0; depth < 12; depth += 1) {
		const entry = path.join(dir, "apps/server/src/index.ts");
		if (existsSync(entry)) {
			return { entry, cwd: path.join(dir, "apps/server") };
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	throw new Error(
		`Could not locate apps/server/src/index.ts above ${import.meta.dir}; set DATAGRIPE_SERVER_ENTRY`,
	);
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

const customCmd = Bun.env.DATAGRIPE_SERVER_CMD;
const { entry, cwd } = customCmd
	? { entry: "", cwd: Bun.env.DATAGRIPE_SERVER_CWD ?? process.cwd() }
	: (() => {
			const override = Bun.env.DATAGRIPE_SERVER_ENTRY;
			if (override !== undefined) {
				return { entry: override, cwd: path.dirname(override) };
			}
			return findServerEntry();
		})();

// The desktop shell is the personal, direct-in deployment: embedded
// postgres under the OS app-data dir, no accounts. Explicit environment
// variables (DATABASE_MODE/APP_DATABASE_URL/AUTH_DISABLED) still win.
const serverEnv = {
	...process.env,
	DATABASE_MODE: Bun.env.DATABASE_MODE ?? "embedded",
	EMBEDDED_PG_DATA_DIR:
		Bun.env.EMBEDDED_PG_DATA_DIR ?? path.join(userData, "pg"),
	AUTH_DISABLED: Bun.env.AUTH_DISABLED ?? "true",
	PORT: String(port),
	WEB_ORIGIN: origin,
	WEB_STATIC_DIR: Bun.env.WEB_STATIC_DIR ?? path.join(cwd, "../web/dist"),
	NODE_ENV: Bun.env.NODE_ENV ?? "production",
};

const command = customCmd
	? [customCmd, ...(Bun.env.DATAGRIPE_SERVER_CMD_ARGS?.split(" ") ?? [])]
	: ["bun", "run", entry];

console.log(`[desktop] starting server: ${command.join(" ")} (cwd ${cwd})`);
const server = Bun.spawn(command, {
	cwd,
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
process.on("exit", stopServer);
process.on("SIGINT", () => {
	stopServer();
	process.exit(0);
});
process.on("SIGTERM", () => {
	stopServer();
	process.exit(0);
});

await waitForServer(port);
console.log(`[desktop] server healthy on ${origin}`);

new BrowserWindow({
	title: "DataGripe",
	url: origin,
	titleBarStyle: "hidden",
	frame: {
		width: 1440,
		height: 900,
	},
});
