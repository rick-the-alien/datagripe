import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExportPlan, ExportPlanEntry } from "@datagripe/contracts";
import type { BuiltExport } from "./exporter";
import { isWithin } from "./paths";

/**
 * Putting the built tree on disk (docs/spec/domains.md "Prune, and dry
 * run first").
 *
 * An export **owns** everything under `domains/` and `access/` plus the
 * two top-level files, and nothing else. Files under those directories
 * that this export did not generate are deleted, so renaming a domain or
 * untagging a table removes its file instead of leaving a stale one to
 * be read as truth a year later.
 *
 * Because that deletes files in a git working tree, `dryRun` comes
 * first: the plan lists writes, unchanged files, deletions and refusals,
 * and nothing happens until somebody has read it.
 */

/** The directories an export owns. Nothing outside them is ever touched. */
export const OWNED_DIRECTORIES = ["domains", "access"];

/**
 * Files at the root the export owns. `pull.log` is deliberately absent:
 * it is append-only and is the one file allowed to be nondeterministic,
 * so the prune must never take it.
 *
 * `manifest.json` is here so an existing dump loses it on the first
 * re-export: `domains.yaml` replaced it (docs/spec/git-datasources.md),
 * and two files claiming to be the round-trip source of truth is worse
 * than either. `domains.yaml` is here too, because a git datasource
 * keeps its copy in the repo's `.datagripe/` and a stale one at the
 * export root should go the same way.
 */
export const OWNED_ROOT_FILES = ["manifest.json", "domains.yaml"];

async function existingFiles(root: string): Promise<Set<string>> {
	const found = new Set<string>();
	for (const directory of OWNED_DIRECTORIES) {
		const absolute = path.join(root, directory);
		let entries: string[];
		try {
			entries = await readdir(absolute, { recursive: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(absolute, entry);
			// `readdir` with `recursive` lists directories too; only files can
			// be pruned, and a directory disappears when it empties.
			const stat = await Bun.file(full)
				.exists()
				.catch(() => false);
			if (stat) {
				found.add(`${directory}/${entry.split(path.sep).join("/")}`);
			}
		}
	}
	for (const name of OWNED_ROOT_FILES) {
		if (await Bun.file(path.join(root, name)).exists()) {
			found.add(name);
		}
	}
	return found;
}

/**
 * Compare, then either report or apply. The two paths share every
 * comparison so a dry run cannot describe a different outcome from the
 * one that follows it.
 */
export async function applyExport(
	root: string,
	built: BuiltExport,
	options: { dryRun: boolean },
): Promise<ExportPlan> {
	const present = await existingFiles(root);
	const entries: ExportPlanEntry[] = [];
	let written = 0;
	let unchanged = 0;
	let deleted = 0;

	const generated = [...built.files.keys()].sort();
	for (const relative of generated) {
		const contents = built.files.get(relative) ?? "";
		const absolute = path.join(root, relative);
		if (!isWithin(root, absolute)) {
			// Belt and braces: `buildExport` already checked every component,
			// and this catches anything it did not think of.
			entries.push({
				path: relative,
				action: "refused",
				reason: "Path escapes the export root",
			});
			continue;
		}
		const current = present.has(relative)
			? await Bun.file(absolute)
					.text()
					.catch(() => null)
			: null;
		if (current === contents) {
			unchanged += 1;
			entries.push({ path: relative, action: "unchanged" });
			continue;
		}
		written += 1;
		entries.push({ path: relative, action: "written" });
		if (!options.dryRun) {
			await mkdir(path.dirname(absolute), { recursive: true });
			await writeFile(absolute, contents, "utf8");
		}
	}

	const generatedSet = new Set(generated);
	for (const relative of [...present].sort()) {
		if (generatedSet.has(relative)) {
			continue;
		}
		deleted += 1;
		entries.push({ path: relative, action: "deleted" });
		if (!options.dryRun) {
			await rm(path.join(root, relative), { force: true });
		}
	}

	entries.push(...built.refusals);
	entries.sort(
		(a, b) => a.action.localeCompare(b.action) || a.path.localeCompare(b.path),
	);

	return {
		root,
		entries,
		domainCount: built.domainCount,
		objectCount: built.objectCount,
		untaggedCount: built.untaggedCount,
		written,
		unchanged,
		deleted,
		refused: built.refusals.length,
		dryRun: options.dryRun,
	};
}

/**
 * `pull.log` is append-only and is the one file allowed to be
 * nondeterministic: it travels in the repository for people reading the
 * dump without DataGripe. It is excluded from the prune for exactly that
 * reason.
 */
export async function appendPullLog(
	root: string,
	line: { actor: string; plan: ExportPlan },
): Promise<void> {
	const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
	const entry = `${stamp} | ${line.actor} | ${line.plan.objectCount} objects | ${line.plan.written} written | ${line.plan.deleted} deleted | ${line.plan.refused} refused\n`;
	const file = path.join(root, "pull.log");
	const existing = await Bun.file(file)
		.text()
		.catch(() => "");
	await writeFile(file, existing + entry, "utf8");
}
