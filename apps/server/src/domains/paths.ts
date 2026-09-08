import { realpath } from "node:fs/promises";
import path from "node:path";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";

/**
 * The gate on every host-filesystem path DataGripe touches — the domain
 * export (docs/spec/domains.md "Where it may write") and the datasource
 * paths the sidebar browses (docs/spec/datasource-paths.md). It lives
 * under `domains/` because export was the first caller; both go through
 * it now.
 *
 * The rules are stricter than anywhere else in the app:
 *
 * - `HOST_FS_DISABLED` turns both off outright, for deployments where
 *   the person pressing the button does not own the host.
 * - `HOST_FS_ROOTS` is an *optional* allowlist. Empty — the default —
 *   means "no allowlist", because the directory is already named
 *   explicitly per datasource and making people configure it twice bought
 *   nothing. Set it when the host is shared.
 * - The path must be absolute either way. With no allowlist a relative
 *   one would quietly resolve against the server's working directory.
 * - The directory is resolved with `realpath` on **every** call, not once
 *   at configuration time, so a symlink swapped in afterwards is caught
 *   rather than trusted.
 * - The allowlist check is segment-wise. A string prefix test would let
 *   `/srv/repos-evil` pass for an allowlisted `/srv/repos`.
 * - Every generated path component is re-checked after joining. Object
 *   names come from a database somebody else may control; a schema
 *   called `../../etc` gets a named error, not a write.
 */

export function parseHostRoots(raw: string): string[] {
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

export interface HostFsPolicy {
	/** Empty means no allowlist — any absolute directory is allowed. */
	roots: string[];
	/** Host filesystem access is off entirely for this deployment. */
	disabled: boolean;
}

/**
 * Resolve a configured directory and prove the deployment allows it.
 * Throws rather than returning null: every caller has to stop, and a
 * nullable return invites a caller that forgets to check.
 *
 * `label` names the setting in the error, so "no directory set" tells
 * the reader which field to go and fill in.
 */
export async function resolveHostDirectory(
	configuredPath: string | null,
	policy: HostFsPolicy,
	label = "export directory",
): Promise<string> {
	if (policy.disabled) {
		throw new ServiceError(
			ErrorCodes.Forbidden,
			"Host filesystem access is disabled — HOST_FS_DISABLED is set",
		);
	}
	if (configuredPath === null || configuredPath.trim() === "") {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`No ${label} is set for this datasource`,
		);
	}
	const trimmed = configuredPath.trim();
	if (!path.isAbsolute(trimmed)) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`The ${label} must be an absolute path: ${trimmed}`,
		);
	}
	let resolved: string;
	try {
		// realpath, not resolve: a symlink pointing out of the allowlist
		// must fail here rather than be followed on write.
		resolved = await realpath(trimmed);
	} catch {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Directory does not exist: ${trimmed}`,
		);
	}
	// No allowlist configured: the explicit per-datasource path is the
	// whole policy.
	if (policy.roots.length === 0) {
		return resolved;
	}
	for (const root of policy.roots) {
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
		`Directory is outside HOST_FS_ROOTS: ${trimmed}`,
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
