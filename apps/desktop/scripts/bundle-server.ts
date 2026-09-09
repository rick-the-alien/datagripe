/**
 * Stage everything the packaged desktop app needs to run without a
 * checkout beside it, into `apps/desktop/staged/`:
 *
 *   staged/server/index.js          the bundled server
 *   staged/server/migrations/*.sql  applied at first boot
 *   staged/server/web/              apps/web/dist, served by the server
 *   staged/pg/{bin,lib,share}       the PostgreSQL binaries
 *
 * `electrobun.config.ts` copies those two into `Resources/app/server` and
 * `Resources/app/pg`, and `src/main.ts` runs the bundled server when it
 * finds it there.
 *
 * PostgreSQL sits at the top rather than under the server, and under a
 * two-letter name, because the installer's tar reader rejects the GNU
 * long-name entries that paths over 100 characters need. Staged the way it
 * is installed — `node_modules/@embedded-postgres/linux-x64/native/share/
 * postgresql/extension/pg_stat_statements--1.11--1.12.sql` — it blows
 * that budget by 40 characters and the install fails with
 * `TarUnsupportedFileType`.
 */
import { cp, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BunPlugin } from "bun";

const desktopDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(desktopDir, "..", "..");
const outDir = path.join(desktopDir, "staged");
const serverOut = path.join(outDir, "server");
const pgOut = path.join(outDir, "pg");

/** The longest path the installer's tar reader can hold in a header. */
const TAR_NAME_MAX = 100;

/**
 * What the staged paths are prefixed with inside the archive. Linux was
 * measured — it is where the limit was found — and macOS is read off the
 * bundle layout Electrobun uses there, `<name>.app/Contents/Resources/`,
 * which is 13 characters longer.
 */
function bundlePrefix(): string {
	return os.platform() === "darwin"
		? "DataGripe.app/Contents/Resources/app/"
		: "DataGripe/Resources/app/";
}

/** The `@embedded-postgres` package holding this platform's binaries. */
function nativePostgresPackage(): string {
	const platform = os.platform() === "win32" ? "windows" : os.platform();
	return `@embedded-postgres/${platform}-${os.arch()}`;
}

/**
 * `embedded-postgres` reaches its binaries through a dynamic
 * `import("@embedded-postgres/<platform>")`, and that package derives
 * their paths from its own `import.meta.url` — which bundling rewrites to
 * the bundle's location, and which anyway would need the package
 * installed at a path too long for the installer's tar reader.
 *
 * So replace it at build time with the three paths it exports, resolved
 * against where the build actually puts the binaries. `DATAGRIPE_PG_DIR`
 * overrides that, for running the bundle from somewhere else.
 */
const pgBinariesShim: BunPlugin = {
	name: "datagripe-pg-binaries",
	setup(build) {
		// One path for all eight platform specifiers, so the shim is
		// bundled once rather than once per branch of that switch.
		build.onResolve({ filter: /^@embedded-postgres\// }, () => ({
			path: "datagripe-pg-binaries",
			namespace: "datagripe-pg",
		}));
		build.onLoad({ filter: /.*/, namespace: "datagripe-pg" }, () => ({
			contents: `
import path from "node:path";

const dir = process.env.DATAGRIPE_PG_DIR ?? path.join(import.meta.dir, "../pg");

export const pg_ctl = path.join(dir, "bin", "pg_ctl");
export const initdb = path.join(dir, "bin", "initdb");
export const postgres = path.join(dir, "bin", "postgres");
`,
			loader: "js",
		}));
	},
};

/**
 * Electrobun's `copy` follows symlinks, and Linux's `native/lib` is a web
 * of them: three names for every shared library, so ICU's 27MB data file
 * would otherwise land in the bundle three times over.
 *
 * Collapse each chain onto the SONAME the loader actually asks for —
 * `libicuuc.so.60`, which is what every library here records — and drop
 * the unversioned `libicuuc.so` a compiler would want along with the
 * static archives nothing at runtime links against.
 *
 * Linux only, and the suffix test is why. macOS names the same chain
 * `libicudata.dylib` → `libicudata.77.dylib` → `libicudata.77.1.dylib`,
 * where nothing ends in `.so`, every link looks like a SONAME to the rule
 * below, and the second one renames a target the first already moved.
 * Getting it right there means reading the Mach-O install name rather
 * than inferring it from the filename, and a wrong guess is a bundle that
 * builds cleanly and fails when somebody runs it. So macOS and Windows
 * ship the duplicated copies — larger, which is a cost, not a defect.
 */
async function pruneNativePostgres(nativeDir: string): Promise<void> {
	if (os.platform() !== "linux") {
		console.log(
			`[bundle-server] skipping the shared-library prune on ${os.platform()}`,
		);
		return;
	}
	const lib = path.join(nativeDir, "lib");
	const entries = await readdir(lib, { withFileTypes: true });
	const links = entries.filter((entry) => entry.isSymbolicLink());

	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith(".a")) {
			await rm(path.join(lib, entry.name));
		}
	}
	for (const link of links.filter((entry) => entry.name.endsWith(".so"))) {
		await rm(path.join(lib, link.name));
	}
	for (const link of links.filter((entry) => !entry.name.endsWith(".so"))) {
		const linkPath = path.join(lib, link.name);
		const target = await realpath(linkPath);
		await rm(linkPath);
		await rename(target, linkPath);
	}
}

/**
 * The installed directory of a package, resolved through bun so the
 * workspace's store layout stays its business, and through realpath so we
 * copy the package rather than a link into the store. Both packages export
 * only `dist/index.js`, so climb out of `dist`.
 */
async function packageDir(specifier: string, from: string): Promise<string> {
	return await realpath(
		path.join(path.dirname(Bun.resolveSync(specifier, from)), ".."),
	);
}

async function run(command: string[], cwd: string): Promise<void> {
	const child = Bun.spawn(command, {
		cwd,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await child.exited) !== 0) {
		throw new Error(`${command.join(" ")} failed in ${cwd}`);
	}
}

/**
 * A path over the tar budget does not fail the build; it fails the
 * install, on someone else's machine, with `TarUnsupportedFileType`.
 *
 * Only Linux fails the build on it. That is where the limit was actually
 * hit — Electrobun's self-extractor rejects the GNU long-name entries a
 * path over 100 characters needs — and macOS installs from a DMG that
 * copies the bundle rather than unpacking it, so the same limit may only
 * apply there to updates, or not at all. Warning rather than failing says
 * what was found without blocking a release on a limit nobody has watched
 * break.
 */
async function checkTarPaths(): Promise<void> {
	const prefix = bundlePrefix();
	const overLong: string[] = [];
	for (const [dest, dir] of [
		["server", serverOut],
		["pg", pgOut],
	] as const) {
		for (const entry of await readdir(dir, { recursive: true })) {
			const archived = `${prefix}${dest}/${entry}`;
			if (archived.length > TAR_NAME_MAX) {
				overLong.push(archived);
			}
		}
	}
	if (overLong.length === 0) {
		return;
	}
	const detail = `${overLong.length} staged path(s) exceed the installer's ${TAR_NAME_MAX}-character tar limit, starting with:\n  ${overLong.slice(0, 5).join("\n  ")}`;
	if (os.platform() === "linux") {
		throw new Error(detail);
	}
	console.warn(`[bundle-server] warning: ${detail}`);
}

// Clear both staging directories but keep them — and their self-ignoring
// `.gitignore` — in place: Electrobun's `copy` fails on a missing source,
// and a dev build that stages nothing still has to build.
for (const dir of [serverOut, pgOut]) {
	await mkdir(dir, { recursive: true });
	for (const entry of await readdir(dir)) {
		if (entry !== ".gitignore") {
			await rm(path.join(dir, entry), { recursive: true, force: true });
		}
	}
}

// The release workflow builds the desktop app without building the web
// app first, so do it here rather than shipping a stale or absent dist.
console.log("[bundle-server] building the web app");
await run(["bun", "run", "--cwd", "apps/web", "build"], repoRoot);

console.log("[bundle-server] bundling the server");
const build = await Bun.build({
	entrypoints: [path.join(repoRoot, "apps/server/src/index.ts")],
	outdir: serverOut,
	naming: "index.js",
	target: "bun",
	plugins: [pgBinariesShim],
});
if (!build.success) {
	for (const message of build.logs) {
		console.error(String(message));
	}
	throw new Error("server bundle failed");
}

console.log("[bundle-server] staging migrations, web assets and postgres");
await cp(
	path.join(repoRoot, "apps/server/migrations"),
	path.join(serverOut, "migrations"),
	{ recursive: true },
);
await cp(path.join(repoRoot, "apps/web/dist"), path.join(serverOut, "web"), {
	recursive: true,
});

const nativePackage = nativePostgresPackage();
// `@embedded-postgres/<platform>` is an optional dependency of
// `embedded-postgres` and not of anything in this workspace, so it is only
// resolvable from where `embedded-postgres` itself landed.
const nativeDir = await packageDir(
	nativePackage,
	await packageDir("embedded-postgres", path.join(repoRoot, "apps/server")),
);
// Only `native/`; `dist/index.js` is the part the shim replaced.
await cp(path.join(nativeDir, "native"), pgOut, {
	recursive: true,
	verbatimSymlinks: true,
});
await pruneNativePostgres(pgOut);

await checkTarPaths();

const migrations = (await readdir(path.join(serverOut, "migrations"))).filter(
	(name) => name.endsWith(".sql"),
);
console.log(
	`[bundle-server] staged ${outDir} (${migrations.length} migrations, ${nativePackage})`,
);
