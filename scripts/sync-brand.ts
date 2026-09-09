/**
 * Copy `brand/` — the one place the shipped brand assets are edited —
 * into every directory that has to serve them from its own tree.
 *
 *   bun run sync:brand     copy, reporting what changed
 *   bun run check:brand    fail if any copy has drifted (CI runs this)
 *
 * The copies stay tracked rather than generated at build time, because
 * the alternative is a build step in three places that do not have one:
 * the Pages deploy uploads `site/` verbatim on purpose, and Vite serves
 * `apps/web/public/` verbatim in dev. A tracked copy plus `check:brand`
 * costs a few hundred kilobytes and cannot break a deploy; a build step
 * cannot cost anything and can break every one of them.
 */
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const brandDir = path.join(repoRoot, "brand");

/** Where each brand asset has to exist, as repo-relative paths. */
const COPIES: { from: string; to: string[] }[] = [
	// Electrobun's `build.linux.icon` (apps/desktop/electrobun.config.ts).
	{ from: "app-icon/icon.png", to: ["apps/desktop/icon.png"] },
	// The favicon, for both the app and the landing page.
	{
		from: "app-icon/icon.svg",
		to: ["apps/web/public/icon.svg", "site/icon.svg"],
	},
	// The PWA manifest's icons (apps/web/vite.config.ts).
	{ from: "app-icon/icon-192.png", to: ["apps/web/public/icon-192.png"] },
	{ from: "app-icon/icon-512.png", to: ["apps/web/public/icon-512.png"] },
	{
		from: "app-icon/icon-maskable-512.png",
		to: ["apps/web/public/icon-maskable-512.png"],
	},
];

/** Whole directories copied file for file, rather than named one by one. */
const TREES: { from: string; to: string[] }[] = [
	// `MascotArt` loads /mascot/<pose>.svg; site/style.css uses the same set.
	{ from: "mascot", to: ["apps/web/public/mascot", "site/mascot"] },
];

const check = process.argv.includes("--check");

async function expand(): Promise<{ from: string; to: string }[]> {
	const pairs: { from: string; to: string }[] = [];
	for (const { from, to } of COPIES) {
		for (const destination of to) {
			pairs.push({ from, to: destination });
		}
	}
	for (const { from, to } of TREES) {
		const names = (await readdir(path.join(brandDir, from))).sort();
		for (const name of names) {
			for (const destination of to) {
				pairs.push({
					from: path.posix.join(from, name),
					to: path.posix.join(destination, name),
				});
			}
		}
	}
	return pairs;
}

async function same(a: string, b: string): Promise<boolean> {
	try {
		return (await readFile(a)).equals(await readFile(b));
	} catch {
		return false;
	}
}

const stale: string[] = [];
for (const { from, to } of await expand()) {
	const source = path.join(brandDir, from);
	const destination = path.join(repoRoot, to);
	if (await same(source, destination)) {
		continue;
	}
	stale.push(to);
	if (!check) {
		await mkdir(path.dirname(destination), { recursive: true });
		await copyFile(source, destination);
		console.log(`[brand] ${to} <- brand/${from}`);
	}
}

if (check && stale.length > 0) {
	console.error(
		`${stale.length} brand cop${stale.length === 1 ? "y is" : "ies are"} out of date with brand/. Run \`bun run sync:brand\` and commit the result:\n  ${stale.join("\n  ")}`,
	);
	process.exit(1);
}

console.log(
	check
		? "[brand] every copy matches brand/"
		: stale.length === 0
			? "[brand] already in sync"
			: `[brand] updated ${stale.length} file(s)`,
);
