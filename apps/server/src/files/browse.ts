import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileEntry } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import { isWithin } from "../domains/paths";

/**
 * Reading and writing inside a datasource path
 * (docs/spec/datasource-paths.md).
 *
 * The containment rules here are deliberately not `safeJoin`'s. That one
 * guards *generated* components against a hostile database and so allows
 * only `[A-Za-z0-9._-]`; these are names that already exist on the
 * user's own disk, where `my query (v2).sql` is an ordinary filename.
 * What is checked instead is the only thing that matters for a path the
 * browser supplied: that the resolved target is still inside the root,
 * proven with `realpath` after the join so a symlink out is caught
 * rather than followed.
 */

/** Above this the editor refuses: it is a SQL editor, not a file viewer. */
export const MAX_FILE_BYTES = 2_000_000;

/**
 * Entries returned for one directory. A checkout can hold a
 * `node_modules` with fifty thousand of them, and the sidebar cannot
 * render that anyway.
 */
export const MAX_DIR_ENTRIES = 2_000;

export function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Resolve a browser-supplied relative path inside an already-resolved
 * root. Returns the real path, which is what every caller then acts on —
 * checking one path and using another is how these bugs happen.
 *
 * `mustExist: false` is for a write to a file that is not there yet: the
 * parent directory is resolved and checked instead.
 */
export async function resolveInside(
	root: string,
	relative: string,
	options: { mustExist?: boolean } = {},
): Promise<string> {
	const mustExist = options.mustExist ?? true;
	// Rejected rather than re-interpreted: stripping the leading slash
	// would turn `/etc/passwd` into a lookup for `<root>/etc/passwd`, and
	// a caller that meant the first one deserves to hear so.
	if (relative.startsWith("/") || path.isAbsolute(relative)) {
		throw new ServiceError(ErrorCodes.BadRequest, "Path must be relative");
	}
	const joined = path.resolve(root, relative);
	// Lexical check first: it rejects `../` without touching the disk.
	if (!isWithin(root, joined)) {
		throw new ServiceError(
			ErrorCodes.Forbidden,
			`Path is outside its datasource path: ${relative}`,
		);
	}
	// Then the real one. A symlink inside the root pointing at /etc
	// passes the lexical check and must not pass this.
	const probe = mustExist ? joined : path.dirname(joined);
	let real: string;
	try {
		real = await realpath(probe);
	} catch {
		throw new ServiceError(ErrorCodes.NotFound, `No such path: ${relative}`);
	}
	if (!isWithin(root, real)) {
		throw new ServiceError(
			ErrorCodes.Forbidden,
			`Path resolves outside its datasource path: ${relative}`,
		);
	}
	return mustExist ? real : path.join(real, path.basename(joined));
}

/** One directory's contents: directories first, then files, each sorted. */
export async function listDirectory(
	root: string,
	subPath: string,
): Promise<FileEntry[]> {
	const directory = await resolveInside(root, subPath);
	const dirents = await readdir(directory, { withFileTypes: true }).catch(
		(error: NodeJS.ErrnoException): never => {
			throw new ServiceError(
				error.code === "EACCES" ? ErrorCodes.Forbidden : ErrorCodes.NotFound,
				error.code === "EACCES"
					? `Not readable: ${subPath === "" ? "the datasource path" : subPath}`
					: `No such directory: ${subPath}`,
			);
		},
	);
	const entries: FileEntry[] = [];
	for (const dirent of dirents.slice(0, MAX_DIR_ENTRIES)) {
		// stat, not lstat: a symlink to a directory should tree like one.
		// Where it points is re-checked on the way in, not here.
		const info = await stat(path.join(directory, dirent.name)).catch(
			() => null,
		);
		if (info === null) {
			continue; // broken symlink or raced deletion — not an error to report
		}
		const isDir = info.isDirectory();
		if (!isDir && !info.isFile()) {
			continue; // sockets, devices, fifos: nothing the editor can open
		}
		entries.push({
			name: dirent.name,
			kind: isDir ? "dir" : "file",
			size: isDir ? null : info.size,
			modifiedAt: info.mtime.toISOString(),
			openable: isDir ? false : info.size <= MAX_FILE_BYTES,
		});
	}
	return entries.sort((a, b) =>
		a.kind === b.kind
			? a.name.localeCompare(b.name)
			: a.kind === "dir"
				? -1
				: 1,
	);
}

export interface FileContents {
	content: string;
	hash: string;
}

/**
 * Read a file as text. Refuses binaries rather than handing the editor a
 * buffer full of NULs it will silently mangle on the next save.
 */
export async function readTextFile(
	root: string,
	relative: string,
): Promise<FileContents> {
	const target = await resolveInside(root, relative);
	const info = await stat(target).catch(() => null);
	if (info === null || !info.isFile()) {
		throw new ServiceError(ErrorCodes.NotFound, `Not a file: ${relative}`);
	}
	if (info.size > MAX_FILE_BYTES) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Too large to open (${Math.round(info.size / 1024)} KB; the limit is ${MAX_FILE_BYTES / 1024} KB)`,
		);
	}
	const buffer = await readFile(target);
	if (buffer.subarray(0, 8192).includes(0)) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Not a text file: ${relative}`,
		);
	}
	const content = buffer.toString("utf8");
	return { content, hash: hashContent(content) };
}

/** Write a file back in place. The parent directory must already exist. */
export async function writeTextFile(
	root: string,
	relative: string,
	content: string,
): Promise<FileContents> {
	const target = await resolveInside(root, relative, { mustExist: false });
	try {
		await writeFile(target, content, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new ServiceError(
			code === "EACCES" || code === "EPERM"
				? ErrorCodes.Forbidden
				: ErrorCodes.BadRequest,
			`Could not write ${relative}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { content, hash: hashContent(content) };
}

/** Hash of what is on disk right now, or null when the file is gone. */
export async function diskHash(
	root: string,
	relative: string,
): Promise<string | null> {
	try {
		const { hash } = await readTextFile(root, relative);
		return hash;
	} catch {
		return null;
	}
}
