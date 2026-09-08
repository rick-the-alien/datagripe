import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	hashContent,
	listDirectory,
	MAX_FILE_BYTES,
	readTextFile,
	resolveInside,
	writeTextFile,
} from "./browse";

/**
 * Containment, not charset (docs/spec/datasource-paths.md "What it may
 * read"). These are the user's own files, so `my query (v2).sql` has to
 * work; what must not work is anything that ends up outside the root.
 */

let root: string;
let outside: string;

beforeAll(async () => {
	// realpath: on macOS the temp dir is itself a symlink, and every
	// containment check here resolves, so the root has to be resolved too.
	root = await realpath(await mkdtemp(path.join(tmpdir(), "dg-browse-")));
	outside = await realpath(await mkdtemp(path.join(tmpdir(), "dg-outside-")));
	await mkdir(path.join(root, "migrations"));
	await writeFile(
		path.join(root, "migrations", "0001 init (v2).sql"),
		"select 1;",
	);
	await writeFile(path.join(root, "queries.sql"), "select 2;");
	await writeFile(path.join(outside, "secret.txt"), "not yours");
	await symlink(outside, path.join(root, "escape"));
	await symlink(path.join(outside, "secret.txt"), path.join(root, "leak.sql"));
});

describe("resolveInside", () => {
	test("an ordinary name with spaces and parentheses resolves", async () => {
		await expect(
			resolveInside(root, "migrations/0001 init (v2).sql"),
		).resolves.toBe(path.join(root, "migrations", "0001 init (v2).sql"));
	});

	test("the empty path is the root itself", async () => {
		await expect(resolveInside(root, "")).resolves.toBe(root);
	});

	test("climbing out is refused", async () => {
		await expect(resolveInside(root, "../secret.txt")).rejects.toThrow(
			/outside/,
		);
	});

	test("an absolute path is refused rather than honoured", async () => {
		await expect(resolveInside(root, "/etc/passwd")).rejects.toThrow(
			/must be relative/,
		);
	});

	test("a symlinked directory pointing out is refused", async () => {
		// It passes the lexical check — `<root>/escape` is inside the root —
		// which is exactly why the realpath check has to exist.
		await expect(resolveInside(root, "escape/secret.txt")).rejects.toThrow(
			/outside/,
		);
	});

	test("a symlinked file pointing out is refused", async () => {
		await expect(readTextFile(root, "leak.sql")).rejects.toThrow(/outside/);
	});
});

describe("listDirectory", () => {
	test("directories come first, then files, each name-sorted", async () => {
		const entries = await listDirectory(root, "");
		const kinds = entries.map((entry) => entry.kind);
		expect(kinds.lastIndexOf("dir")).toBeLessThan(kinds.indexOf("file"));
		const files = entries
			.filter((entry) => entry.kind === "file")
			.map((entry) => entry.name);
		expect(files).toEqual([...files].sort((a, b) => a.localeCompare(b)));
		expect(entries.find((entry) => entry.name === "queries.sql")).toMatchObject(
			{ kind: "file", openable: true },
		);
	});

	test("a symlink to a directory trees like a directory", async () => {
		// Listing it is harmless; going *into* it is what resolveInside
		// refuses, and that is the check that matters.
		const entries = await listDirectory(root, "");
		expect(entries.find((entry) => entry.name === "escape")?.kind).toBe("dir");
	});

	test("a missing directory is a not-found, not an empty list", async () => {
		await expect(listDirectory(root, "nope")).rejects.toThrow(/No such/);
	});
});

describe("readTextFile", () => {
	test("reads a file and hashes what it read", async () => {
		const result = await readTextFile(root, "queries.sql");
		expect(result.content).toBe("select 2;");
		expect(result.hash).toBe(hashContent("select 2;"));
	});

	test("a binary file is refused rather than mangled", async () => {
		// Handing the editor a buffer full of NULs means the next save
		// writes back a corrupted file, silently.
		await writeFile(path.join(root, "blob.bin"), Buffer.from([1, 0, 2, 0]));
		await expect(readTextFile(root, "blob.bin")).rejects.toThrow(/text file/);
	});

	test("a file over the cap is refused with its size", async () => {
		await writeFile(
			path.join(root, "huge.sql"),
			"x".repeat(MAX_FILE_BYTES + 1),
		);
		await expect(readTextFile(root, "huge.sql")).rejects.toThrow(/Too large/);
	});
});

describe("writeTextFile", () => {
	test("writes in place and returns the new hash", async () => {
		await writeTextFile(root, "queries.sql", "select 3;");
		const result = await readTextFile(root, "queries.sql");
		expect(result.content).toBe("select 3;");
		expect(result.hash).toBe(hashContent("select 3;"));
	});

	test("creates a file that is not there yet, inside the root", async () => {
		await writeTextFile(root, "migrations/0002.sql", "select 4;");
		await expect(
			readTextFile(root, "migrations/0002.sql"),
		).resolves.toMatchObject({ content: "select 4;" });
	});

	test("a write that would land outside is refused", async () => {
		await expect(
			writeTextFile(root, "escape/planted.sql", "select 5;"),
		).rejects.toThrow(/outside/);
	});
});
