import { describe, expect, test } from "bun:test";
import type { ConnectionMetadata } from "@datagripe/contracts";
import { locateInPaths, relativeUnder } from "./openRepoFile";

/**
 * Mapping a repository row onto a datasource path
 * (docs/spec/git-datasources.md "The repository section").
 *
 * Two path vocabularies meet here: git names files relative to the work
 * tree root, and the editor names them relative to a configured pair.
 * A row that falls outside every pair must open *nothing*, because the
 * only alternatives are opening the wrong file or pretending the click
 * did not happen.
 */

function connection(
	paths: Array<{ id: string; name: string; path: string }>,
): ConnectionMetadata {
	return {
		id: "git:1",
		workspaceId: "w",
		name: "wallet",
		adapter: "postgres",
		host: "h",
		port: 5432,
		databaseName: "wallet",
		username: "u",
		tlsMode: "disable",
		readOnly: true,
		showAllSchemas: false,
		domainExportPath: null,
		paths,
		source: "git",
		branding: null,
		unavailable: null,
		createdAt: "2026-09-08T00:00:00.000Z",
		updatedAt: "2026-09-08T00:00:00.000Z",
	};
}

describe("relativeUnder", () => {
	test("a child comes back relative", () => {
		expect(relativeUnder("/srv/repo", "/srv/repo/foo/a.sql")).toBe("foo/a.sql");
	});

	test("a sibling with a shared prefix is not underneath", () => {
		// The `/srv/repo-evil` case a string prefix test would let through.
		expect(relativeUnder("/srv/repo", "/srv/repo-evil/a.sql")).toBeNull();
	});

	test("a trailing slash on either side does not change the answer", () => {
		expect(relativeUnder("/srv/repo/", "/srv/repo/foo")).toBe("foo");
	});
});

describe("locateInPaths", () => {
	const meta = connection([
		{ id: "p-all", name: "checkout", path: "/srv/repo" },
		{ id: "p-foo", name: "Some Folder", path: "/srv/repo/foo" },
	]);

	test("finds the file inside its path pair", () => {
		expect(locateInPaths(meta, "/srv/repo", "bar/baz/query22.sql")).toEqual({
			pathId: "p-all",
			filePath: "bar/baz/query22.sql",
		});
	});

	test("the most specific pair wins", () => {
		// A nested pair should win over the checkout-wide one that also
		// contains it, or the file opens from the wrong section.
		expect(locateInPaths(meta, "/srv/repo", "foo/blah.sql")).toEqual({
			pathId: "p-foo",
			filePath: "blah.sql",
		});
	});

	test("a file under no configured pair is unreachable from here", () => {
		const narrow = connection([
			{ id: "p-foo", name: "Some Folder", path: "/srv/repo/foo" },
		]);
		expect(locateInPaths(narrow, "/srv/repo", "bar/other.sql")).toBeNull();
		// `.datagripe/config.yaml` is a changed file people will click on,
		// and it is only openable when a pair covers it.
		expect(
			locateInPaths(narrow, "/srv/repo", ".datagripe/config.yaml"),
		).toBeNull();
	});
});
