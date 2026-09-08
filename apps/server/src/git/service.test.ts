import { describe, expect, test } from "bun:test";
import { createSsrfPolicy } from "../security/ssrf";
import { assertCloneUrl } from "./service";

/**
 * What a clone may reach (docs/spec/git-datasources.md "Adding one").
 *
 * A clone URL is the same kind of thing as a connection host — a
 * user-supplied name the server is about to connect to — so it goes
 * through the same SSRF policy. The additions here are about scheme:
 * `git clone` will happily read a local path or a `file://` URL, and
 * a clone from `/etc` is not a feature.
 */

const OPEN = createSsrfPolicy("", true);
const GUARDED = createSsrfPolicy("", false);

describe("assertCloneUrl", () => {
	test("https and ssh URLs are allowed", async () => {
		for (const url of [
			"https://github.com/you/wallet.git",
			"ssh://git@github.com/you/wallet.git",
		]) {
			await expect(assertCloneUrl(url, OPEN)).resolves.toBeUndefined();
		}
	});

	test("the scp form is allowed", async () => {
		await expect(
			assertCloneUrl("git@github.com:you/wallet.git", OPEN),
		).resolves.toBeUndefined();
	});

	test("file:// is refused before any process is spawned", async () => {
		await expect(assertCloneUrl("file:///etc", OPEN)).rejects.toThrow(
			/Refusing to clone a file: URL/,
		);
	});

	test("a bare local path is not a git URL", async () => {
		for (const url of ["/etc", "./repo", "../repo"]) {
			await expect(assertCloneUrl(url, OPEN)).rejects.toThrow(/Not a git URL/);
		}
	});

	test("a private-range host is refused when SSRF blocking is on", async () => {
		// Same policy as a connection host: a clone that reaches the
		// metadata service is the same problem as a query that does.
		await expect(
			assertCloneUrl("https://127.0.0.1/repo.git", GUARDED),
		).rejects.toThrow();
	});
});
