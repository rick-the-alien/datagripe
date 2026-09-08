import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	assertSafeComponent,
	isWithin,
	objectDirectory,
	objectFileName,
	parseHostRoots,
	resolveHostDirectory,
	routineSlug,
	safeJoin,
	UnsafePathError,
} from "./paths";

/**
 * Path safety (docs/spec/domains.md "Where it may write").
 *
 * Export is the one action in the app that writes to the host
 * filesystem, and every object name it puts in a path comes from a
 * database somebody else may control. These are the tests that keep it
 * from being a file-write primitive.
 */

describe("isWithin", () => {
	test("a sibling with a shared prefix is not inside", () => {
		// The reason the check is segment-wise rather than a string prefix.
		expect(isWithin("/srv/repos", "/srv/repos-evil")).toBe(false);
		expect(isWithin("/srv/repos", "/srv/repos-evil/x")).toBe(false);
	});

	test("the root itself and its descendants are inside", () => {
		expect(isWithin("/srv/repos", "/srv/repos")).toBe(true);
		expect(isWithin("/srv/repos", "/srv/repos/a/b")).toBe(true);
	});

	test("traversal out is not inside", () => {
		expect(isWithin("/srv/repos", "/srv/repos/../etc")).toBe(false);
	});
});

describe("assertSafeComponent", () => {
	test("refuses traversal, separators, and control bytes", () => {
		for (const bad of ["..", ".", "", "a/b", "a\\b", "a\u0000b", "a b"]) {
			expect(() => assertSafeComponent(bad)).toThrow(UnsafePathError);
		}
	});

	test("accepts a plain filename", () => {
		expect(assertSafeComponent("public.users.sql")).toBe("public.users.sql");
	});
});

describe("safeJoin", () => {
	test("refuses a schema named ../../etc", () => {
		expect(() => safeJoin("/root", "domains", "../../etc", "x.sql")).toThrow(
			UnsafePathError,
		);
	});

	test("joins a safe path under the root", () => {
		expect(safeJoin("/root", "domains", "auth", "tables")).toBe(
			"/root/domains/auth/tables",
		);
	});
});

describe("routineSlug", () => {
	test("keeps overloads distinct", () => {
		const a = routineSlug("login(text, text)");
		const b = routineSlug("login(integer)");
		expect(a.base).toBe("login");
		expect(a.args).not.toBe(b.args);
	});

	test("a no-argument routine has no suffix", () => {
		expect(routineSlug("total()")).toEqual({ base: "total", args: "" });
	});

	test("a long argument list truncates and stays stable and distinct", () => {
		const long = `f(${Array.from({ length: 30 }, (_, i) => `character varying_${i}`).join(", ")})`;
		const other = `f(${Array.from({ length: 30 }, (_, i) => `character varying_${i + 1}`).join(", ")})`;
		const slug = routineSlug(long);
		expect(slug.args.length).toBeLessThanOrEqual(57);
		// Stable across calls, and still not equal to a different overload
		// whose first 48 characters happen to match.
		expect(routineSlug(long).args).toBe(slug.args);
		expect(routineSlug(other).args).not.toBe(slug.args);
	});
});

describe("objectFileName", () => {
	test("schema-qualifies, because two schemas can hold a users table", () => {
		expect(objectFileName("table", "basic_auth", "users")).toBe(
			"basic_auth.users.sql",
		);
		expect(objectFileName("table", "public", "users")).toBe("public.users.sql");
	});

	test("a routine carries its argument slug", () => {
		expect(objectFileName("function", "public", "login(text, text)")).toBe(
			"public.login__text-text.sql",
		);
	});
});

describe("objectDirectory", () => {
	test("functions and procedures share routines/", () => {
		expect(objectDirectory("function")).toBe("routines");
		expect(objectDirectory("procedure")).toBe("routines");
	});
});

describe("resolveHostDirectory", () => {
	const open = { roots: [] as string[], disabled: false };
	const allow = (root: string) => ({ roots: [root], disabled: false });

	test("no allowlist means the per-datasource path is the whole policy", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "dg-open-"));
		await expect(resolveHostDirectory(dir, open)).resolves.toContain(
			"dg-open-",
		);
	});

	test("HOST_FS_DISABLED refuses even an explicit directory", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "dg-off-"));
		await expect(
			resolveHostDirectory(dir, { roots: [], disabled: true }),
		).rejects.toThrow(/HOST_FS_DISABLED/);
	});

	test("a relative path is refused rather than resolved against the cwd", async () => {
		await expect(resolveHostDirectory("./data", open)).rejects.toThrow(
			/absolute/,
		);
	});

	test("no configured path is a refusal, not a default", async () => {
		await expect(resolveHostDirectory(null, allow("/tmp"))).rejects.toThrow(
			/No export directory is set/i,
		);
	});

	test("the label names the setting the reader has to go and fill in", async () => {
		await expect(
			resolveHostDirectory("", open, "datasource path"),
		).rejects.toThrow(/No datasource path is set/i);
	});

	test("a directory outside the allowlist is refused", async () => {
		const allowed = await mkdtemp(path.join(tmpdir(), "dg-allowed-"));
		const other = await mkdtemp(path.join(tmpdir(), "dg-other-"));
		await expect(resolveHostDirectory(other, allow(allowed))).rejects.toThrow(
			/outside HOST_FS_ROOTS/,
		);
	});

	test("a sibling sharing the allowlist's prefix is refused", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "dg-prefix-"));
		const allowed = path.join(base, "repos");
		const evil = path.join(base, "repos-evil");
		await mkdir(allowed);
		await mkdir(evil);
		await expect(resolveHostDirectory(evil, allow(allowed))).rejects.toThrow(
			/outside HOST_FS_ROOTS/,
		);
	});

	test("a symlink pointing out of the allowlist is refused", async () => {
		// Resolved with realpath on every call, not once at configuration
		// time, so a symlink swapped in afterwards is caught.
		const base = await mkdtemp(path.join(tmpdir(), "dg-link-"));
		const allowed = path.join(base, "allowed");
		const outside = path.join(base, "outside");
		await mkdir(allowed);
		await mkdir(outside);
		const link = path.join(allowed, "escape");
		await symlink(outside, link);
		await expect(resolveHostDirectory(link, allow(allowed))).rejects.toThrow(
			/outside HOST_FS_ROOTS/,
		);
	});

	test("an allowed directory resolves", async () => {
		const allowed = await mkdtemp(path.join(tmpdir(), "dg-ok-"));
		const nested = path.join(allowed, "project", "schema");
		await mkdir(nested, { recursive: true });
		await expect(
			resolveHostDirectory(nested, allow(allowed)),
		).resolves.toContain("schema");
	});
});

describe("parseHostRoots", () => {
	test("splits on colons and drops blanks", () => {
		expect(parseHostRoots("/a:/b::  ")).toEqual(["/a", "/b"]);
	});

	test("an empty string is no roots at all", () => {
		expect(parseHostRoots("")).toEqual([]);
	});
});
