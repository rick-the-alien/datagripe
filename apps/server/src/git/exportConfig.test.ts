import { describe, expect, test } from "bun:test";
import { passwordEnvName, relativise } from "./exportConfig";

/**
 * Generating a `.datagripe/` set from an existing datasource
 * (docs/spec/git-datasources.md "Exporting a config from an existing
 * datasource").
 *
 * The two pure decisions it makes: what to call the environment
 * variable, and what to do with a path that is not in the repository.
 */

describe("passwordEnvName", () => {
	test("shouts the datasource name", () => {
		expect(passwordEnvName("wallet-prod")).toBe("WALLET_PROD_PASSWORD");
		expect(passwordEnvName("Analytics (read only)")).toBe(
			"ANALYTICS_READ_ONLY_PASSWORD",
		);
	});

	test("a name with nothing usable still produces a variable", () => {
		expect(passwordEnvName("—")).toBe("DATASOURCE_PASSWORD");
		expect(passwordEnvName("")).toBe("DATASOURCE_PASSWORD");
	});
});

describe("relativise", () => {
	test("a directory inside the repo comes back POSIX-relative", () => {
		expect(relativise("/srv/repo", "/srv/repo/db/migrations")).toBe(
			"db/migrations",
		);
	});

	test("a directory outside the repo is null, never a climbing path", () => {
		// Written as a comment with its absolute path instead. Silently
		// dropping it is how a teammate ends up with three of your four
		// sections; writing `../../elsewhere` is worse.
		expect(relativise("/srv/repo", "/srv/other")).toBeNull();
		expect(relativise("/srv/repo", "/etc")).toBeNull();
	});

	test("a sibling with a shared prefix is outside", () => {
		// The `/srv/repos-evil` case: a string prefix test would pass this.
		expect(relativise("/srv/repo", "/srv/repo-evil/x")).toBeNull();
	});

	test("the repository root itself is not a path pair", () => {
		// A section titled after the whole checkout is the file tree, not a
		// shortcut into it.
		expect(relativise("/srv/repo", "/srv/repo")).toBeNull();
	});
});
