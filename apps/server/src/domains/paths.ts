import { realpath } from "node:fs/promises";
import path from "node:path";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";

/**
 * Where the export may write (docs/spec/domains.md "Where it may write").
 *
 * Export is the one action in the app that writes to the host
 * filesystem, so the rules are stricter than anywhere else:
 *
 * - `DOMAIN_EXPORT_ROOTS` is empty by default, and empty means disabled.
 * - The chosen directory is resolved with `realpath` on **every** export,
 *   not once at configuration time, so a symlink swapped in afterwards
 *   is caught rather than trusted.
 * - The allowlist check is segment-wise. A string prefix test would let
 *   `/srv/repos-evil` pass for an allowlisted `/srv/repos`.
 * - Every generated path component is re-checked after joining. Object
 *   names come from a database somebody else may control; a schema
 *   called `../../etc` gets a named error, not a write.
 */

export function parseExportRoots(raw: string): string[] {
	return raw
		.split(":")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "")
		.map((entry) => path.resolve(entry));
}

/**
 * True when `child` is `parent` or lives beneath it, compared segment by
 * segment. `/srv/repos-evil` is not under `/srv/repos`.
 */
export function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	if (relative === "") {
		return true;
	}
	return (
		!relative.startsWith("..") &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

/**
 * Resolve the workspace's export path and prove it is allowed. Throws
 * rather than returning null: every caller has to stop, and a nullable
 * return invites a caller that forgets to check.
 */
export async function resolveExportRoot(
	configuredPath: string | null,
	allowedRoots: string[],
): Promise<string> {
	if (allowedRoots.length === 0) {
		throw new ServiceError(
			ErrorCodes.Forbidden,
			"Export is disabled — DOMAIN_EXPORT_ROOTS is not configured",
		);
	}
	if (configuredPath === null || configuredPath.trim() === "") {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			"This project has no export directory set",
		);
	}
	let resolved: string;
	try {
		// realpath, not resolve: a symlink pointing out of the allowlist
		// must fail here rather than be followed on write.
		resolved = await realpath(path.resolve(configuredPath));
	} catch {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Export directory does not exist: ${configuredPath}`,
		);
	}
	for (const root of allowedRoots) {
		let realRoot: string;
		try {
			realRoot = await realpath(root);
		} catch {
			continue;
		}
		if (isWithin(realRoot, resolved)) {
			return resolved;
		}
	}
	throw new ServiceError(
		ErrorCodes.Forbidden,
		`Export directory is outside DOMAIN_EXPORT_ROOTS: ${configuredPath}`,
	);
}

/**
 * Characters a generated path component may contain. Deliberately narrow
 * — this is applied to schema, object and domain names that arrive from
 * the target database.
 */
const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;

export class UnsafePathError extends Error {
	constructor(component: string) {
		super(`Refusing to write a path component: ${JSON.stringify(component)}`);
		this.name = "UnsafePathError";
	}
}

/** Throws `UnsafePathError` for anything that is not a plain filename. */
export function assertSafeComponent(component: string): string {
	if (
		component === "" ||
		component === "." ||
		component === ".." ||
		!SAFE_COMPONENT.test(component)
	) {
		throw new UnsafePathError(component);
	}
	return component;
}

/**
 * Join components under the root, checking each one and then checking
 * the result. Both halves matter: the component test catches `..` and
 * separators, and the containment test catches anything the first test
 * did not think of.
 */
export function safeJoin(root: string, ...components: string[]): string {
	for (const component of components) {
		assertSafeComponent(component);
	}
	const joined = path.join(root, ...components);
	if (!isWithin(root, joined)) {
		throw new UnsafePathError(components.join("/"));
	}
	return joined;
}

/**
 * A filesystem-safe slug for a PostgreSQL routine's identity arguments.
 *
 * A routine's name carries its arguments — `login(text, text)` — which
 * are not filesystem-safe, and two overloads must not collide. Over 48
 * characters the slug truncates and appends a hash of the full argument
 * list, so it stays distinct and stays stable across exports.
 */
export function routineSlug(name: string): { base: string; args: string } {
	const open = name.indexOf("(");
	if (open === -1) {
		return { base: name, args: "" };
	}
	const base = name.slice(0, open);
	const rawArgs = name.slice(open + 1, name.lastIndexOf(")"));
	if (rawArgs.trim() === "") {
		return { base, args: "" };
	}
	const slug = rawArgs
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length <= 48) {
		return { base, args: slug };
	}
	const hash = new Bun.CryptoHasher("sha256")
		.update(rawArgs)
		.digest("hex")
		.slice(0, 8);
	return { base, args: `${slug.slice(0, 48).replace(/-+$/, "")}-${hash}` };
}

/**
 * The export filename for one object, without its directory.
 *
 * Throws `UnsafePathError` for anything that would not be a plain
 * filename. The check belongs here rather than only at the join, because
 * this is the function that turns a database-supplied name into a path
 * component — a schema called `../../etc` would otherwise become
 * `../../etc.passwd.sql`, which `path.join` is perfectly happy to
 * resolve outside the root.
 */
export function objectFileName(
	kind: string,
	schema: string,
	name: string,
): string {
	assertSafeComponent(schema);
	if (kind === "function" || kind === "procedure") {
		const { base, args } = routineSlug(name);
		assertSafeComponent(base);
		return assertSafeComponent(
			args === "" ? `${schema}.${base}.sql` : `${schema}.${base}__${args}.sql`,
		);
	}
	assertSafeComponent(name);
	return `${schema}.${name}.sql`;
}

/** The subdirectory an object kind is exported into. */
export function objectDirectory(kind: string): string {
	switch (kind) {
		case "view":
			return "views";
		case "function":
		case "procedure":
			// Functions and procedures share one directory: the distinction is
			// already in the DDL, and a `procedures/` that is empty on every
			// engine but MySQL is noise.
			return "routines";
		case "sequence":
			return "sequences";
		default:
			return "tables";
	}
}
