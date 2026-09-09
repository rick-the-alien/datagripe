/**
 * Rasterise `brand/app-icon/icon.svg` into the PNG sizes the platforms
 * ask for. Run it when the artwork changes, then `bun run sync:brand` to
 * copy the results into place:
 *
 *   bun run brand:render && bun run sync:brand
 *
 * Deliberately not part of any build. Rasterising is an art step that
 * needs `rsvg-convert` and ImageMagick, and neither the web build nor the
 * Pages deploy should grow a dependency on them to ship a file that only
 * changes when someone redraws the icon.
 */
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const iconDir = path.join(repoRoot, "brand", "app-icon");
const source = path.join(iconDir, "icon.svg");

/**
 * A maskable icon is masked to whatever shape the platform likes, so the
 * artwork has to sit well inside the square with the rest filled in — the
 * `#0B0E14` the rest of the brand uses as its darkest surface. 64% leaves
 * the mark comfortably inside the 80% safe zone the spec guarantees.
 */
const MASKABLE_INSET = 0.64;
const MASKABLE_BACKGROUND = "#0B0E14";

/** Square PNGs rendered straight from the SVG, transparent corners kept. */
const PLAIN: { name: string; size: number; note: string }[] = [
	{ name: "icon.png", size: 256, note: "desktop launcher (hicolor 256x256)" },
	{ name: "icon-192.png", size: 192, note: "PWA / apple-touch-icon" },
	{ name: "icon-512.png", size: 512, note: "PWA" },
];

async function run(command: string[]): Promise<void> {
	const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
	if ((await child.exited) !== 0) {
		throw new Error(`${command[0]} failed: ${command.join(" ")}`);
	}
}

async function requireTool(name: string): Promise<void> {
	if (Bun.which(name) === null) {
		throw new Error(
			`${name} is not on PATH; it is needed to rasterise ${path.relative(repoRoot, source)}`,
		);
	}
}

await access(source);
await requireTool("rsvg-convert");
await requireTool("magick");

for (const { name, size, note } of PLAIN) {
	const out = path.join(iconDir, name);
	await run([
		"rsvg-convert",
		"-w",
		String(size),
		"-h",
		String(size),
		source,
		"-o",
		out,
	]);
	console.log(`[brand] ${name} — ${size}x${size}, ${note}`);
}

const maskableSize = 512;
const artSize = Math.round(maskableSize * MASKABLE_INSET);
const scratch = await mkdtemp(path.join(tmpdir(), "datagripe-brand-"));
try {
	const art = path.join(scratch, "art.png");
	await run([
		"rsvg-convert",
		"-w",
		String(artSize),
		"-h",
		String(artSize),
		source,
		"-o",
		art,
	]);
	await run([
		"magick",
		"-size",
		`${maskableSize}x${maskableSize}`,
		`xc:${MASKABLE_BACKGROUND}`,
		art,
		"-gravity",
		"center",
		"-composite",
		path.join(iconDir, "icon-maskable-512.png"),
	]);
	console.log(
		`[brand] icon-maskable-512.png — ${maskableSize}x${maskableSize}, art at ${Math.round(MASKABLE_INSET * 100)}% on ${MASKABLE_BACKGROUND}`,
	);
} finally {
	await rm(scratch, { recursive: true, force: true });
}
