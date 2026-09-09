import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ConnectionMetadata, DatasourcePath } from "@datagripe/contracts";
import { ADAPTER_CAPABILITIES } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import { resolveHostDirectory } from "../domains/paths";
import { listDomains } from "../domains/service";
import { MAX_FILE_BYTES, readTextFile } from "../files/browse";
import type { McpContext, McpDeps } from "./context";

/**
 * What the project knows about itself (docs/spec/mcp.md).
 *
 * The schema is discoverable by introspection; this module is the other
 * half — the datasources, the domain map, and the files where somebody
 * wrote down what the catalogue cannot say.
 */

/** Directories no index should walk into. None of them are project docs. */
const SKIP_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"target",
	"vendor",
	"__pycache__",
	".venv",
	".next",
	".cache",
]);

/**
 * Extensions the index lists. An allowlist, not a filter: the point is
 * the prose and the queries a person wrote, and a `.png` in a docs
 * folder is not something an agent can read anyway.
 */
const TEXT_EXTENSIONS = new Set([
	".md",
	".markdown",
	".sql",
	".txt",
	".yaml",
	".yml",
	".toml",
	".json",
	".csv",
	".conf",
	".ini",
	".sh",
	".env.example",
]);

/** Per path pair. A checkout can hold more files than anyone can read. */
const MAX_INDEX_ENTRIES = 400;
const MAX_INDEX_DEPTH = 6;

export interface ExposedFile {
	uri: string;
	/** How to say where this is, in one line. */
	label: string;
	kind: "document" | "file";
	/** Bytes on disk; null for a workspace document. */
	size: number | null;
	datasourceRef?: string;
}

function isTextName(name: string): boolean {
	return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Datasources this project exposes: all of them (docs/spec/mcp.md). */
export async function datasources(
	deps: McpDeps,
	ctx: McpContext,
): Promise<ConnectionMetadata[]> {
	return deps.connections.listConnections(ctx.workspace);
}

/**
 * The datasource a tool call means. Named beats guessed, but a project
 * with one obvious answer should not make an agent repeat it, so the
 * project's default connection stands in — and when there is neither, the
 * error lists the refs rather than saying "not found".
 */
export async function resolveDatasource(
	deps: McpDeps,
	ctx: McpContext,
	ref: string | undefined,
): Promise<ConnectionMetadata> {
	const list = await datasources(deps, ctx);
	if (ref !== undefined) {
		const byRef =
			list.find((entry) => entry.id === ref) ??
			list.find((entry) => entry.name === ref);
		if (byRef === undefined) {
			throw new ServiceError(
				ErrorCodes.NotFound,
				`No datasource '${ref}' in this project. Available: ${list
					.map((entry) => `${entry.id} (${entry.name})`)
					.join(", ")}`,
			);
		}
		return byRef;
	}
	const fallback =
		list.find((entry) => entry.id === ctx.workspace.defaultConnectionRef) ??
		(list.length === 1 ? list[0] : undefined);
	if (fallback === undefined) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`This project has ${list.length} datasources and no default, so name one: ${list
				.map((entry) => `${entry.id} (${entry.name})`)
				.join(", ")}`,
		);
	}
	return fallback;
}

/** Refuse early, and in the datasource's own words. */
export function requireUsable(datasource: ConnectionMetadata): void {
	if (datasource.unavailable !== null) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Datasource '${datasource.name}' cannot be connected to: ${datasource.unavailable}`,
		);
	}
}

/**
 * Walk one path pair, listing the text files under it. Bounded twice —
 * depth and count — because an index is for finding a runbook, not for
 * mirroring a checkout.
 */
async function indexPath(
	root: string,
	pathId: string,
	sectionName: string,
	datasourceRef: string,
): Promise<ExposedFile[]> {
	const found: ExposedFile[] = [];
	const walk = async (relative: string, depth: number): Promise<void> => {
		if (depth > MAX_INDEX_DEPTH || found.length >= MAX_INDEX_ENTRIES) {
			return;
		}
		const absolute = path.join(root, relative);
		const entries = await readdir(absolute, { withFileTypes: true }).catch(
			() => [],
		);
		for (const entry of entries) {
			if (found.length >= MAX_INDEX_ENTRIES) {
				return;
			}
			if (entry.name.startsWith(".") && entry.name !== ".datagripe") {
				continue;
			}
			const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
			// stat, not the dirent: a symlinked docs directory should index.
			const info = await stat(path.join(root, child)).catch(() => null);
			if (info === null) {
				continue;
			}
			if (info.isDirectory()) {
				if (!SKIP_DIRECTORIES.has(entry.name)) {
					await walk(child, depth + 1);
				}
				continue;
			}
			if (
				!info.isFile() ||
				!isTextName(entry.name) ||
				info.size > MAX_FILE_BYTES
			) {
				continue;
			}
			found.push({
				uri: `datagripe://file/${pathId}/${child}`,
				label: `${sectionName}/${child}`,
				kind: "file",
				size: info.size,
				datasourceRef,
			});
		}
	};
	await walk("", 0);
	return found;
}

interface PathRoot {
	pathId: string;
	name: string;
	root: string;
	datasourceRef: string;
}

/**
 * Every configured path pair that resolves right now, with the ones that
 * do not silently dropped: a directory somebody moved is not a reason
 * for the whole index to fail.
 */
async function pathRoots(deps: McpDeps, ctx: McpContext): Promise<PathRoot[]> {
	const roots: PathRoot[] = [];
	for (const datasource of await datasources(deps, ctx)) {
		for (const pair of datasource.paths as DatasourcePath[]) {
			const root = await resolveHostDirectory(
				pair.path,
				deps.hostFs,
				"datasource path",
			).catch(() => null);
			if (root !== null) {
				roots.push({
					pathId: pair.id,
					name: pair.name,
					root,
					datasourceRef: datasource.id,
				});
			}
		}
	}
	return roots;
}

/**
 * The file index: workspace documents, then every path pair's tree.
 *
 * Both are exposed because both are the feature. A workspace file is
 * where the project explains how its datasources fit together; a file
 * under a path pair is where a datasource explains itself.
 */
export async function listExposedFiles(
	deps: McpDeps,
	ctx: McpContext,
): Promise<ExposedFile[]> {
	const documents = await deps.documents.listDocuments(ctx.workspace.id);
	const files: ExposedFile[] = documents
		// A file-backed document is listed once, as the file it came from:
		// the artifact on disk is what a teammate's checkout holds.
		.filter((entry) => entry.origin === null)
		.map((entry) => ({
			uri: `datagripe://doc/${entry.id}`,
			label: entry.title,
			kind: "document" as const,
			size: null,
		}));
	for (const root of await pathRoots(deps, ctx)) {
		files.push(
			...(await indexPath(
				root.root,
				root.pathId,
				root.name,
				root.datasourceRef,
			)),
		);
	}
	return files;
}

interface ParsedUri {
	kind: "doc" | "file";
	id: string;
	relative: string;
}

/** `datagripe://doc/<id>` or `datagripe://file/<pathId>/<relative>`. */
export function parseUri(uri: string): ParsedUri {
	const match = /^datagripe:\/\/(doc|file)\/([^/]+)(?:\/(.*))?$/.exec(uri);
	const kind = match?.[1];
	const id = match?.[2];
	if (match === null || kind === undefined || id === undefined) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Not a DataGripe uri: ${uri}. Use the uri list_docs gave you.`,
		);
	}
	if (kind === "file" && (match[3] ?? "") === "") {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`That uri names a datasource path but no file inside it: ${uri}`,
		);
	}
	return {
		kind: kind as "doc" | "file",
		id,
		relative: match[3] ?? "",
	};
}

export interface ReadResult {
	uri: string;
	label: string;
	text: string;
	truncated: boolean;
	/**
	 * What to pass back as `offset` to continue. Opaque to the caller —
	 * the cap is in bytes and this counts characters, and reconciling the
	 * two is our problem rather than the agent's.
	 */
	nextOffset: number | null;
	/** Size of the whole file, so a reader can see what it is in for. */
	sizeBytes: number;
}

/**
 * Read one exposed file, verbatim and paginated.
 *
 * Verbatim on purpose: markdown is never rendered here. The `sql` fences
 * in a runbook are the most useful part of it, and a reader that
 * stripped them would be hiding the answer.
 */
export async function readExposed(
	deps: McpDeps,
	ctx: McpContext,
	uri: string,
	offset: number,
): Promise<ReadResult> {
	const parsed = parseUri(uri);
	const cap = deps.config.MCP_READ_MAX_BYTES;
	if (parsed.kind === "doc") {
		const document = await deps.documents.getDocument(
			ctx.workspace.id,
			parsed.id,
		);
		return slice(uri, document.title, document.content, offset, cap);
	}
	const root = await pathRootFor(deps, ctx, parsed.id);
	const { content } = await readTextFile(root.root, parsed.relative);
	return slice(uri, `${root.name}/${parsed.relative}`, content, offset, cap);
}

/** The path pair behind a uri, proven to belong to this project. */
async function pathRootFor(
	deps: McpDeps,
	ctx: McpContext,
	pathId: string,
): Promise<PathRoot> {
	const root = (await pathRoots(deps, ctx)).find(
		(candidate) => candidate.pathId === pathId,
	);
	if (root === undefined) {
		throw new ServiceError(
			ErrorCodes.NotFound,
			"That datasource path is not part of this project any more",
		);
	}
	return root;
}

function slice(
	uri: string,
	label: string,
	content: string,
	offset: number,
	cap: number,
): ReadResult {
	// Bytes, because the cap is about what a client can hold, but sliced
	// on a character boundary so the text stays valid UTF-8.
	const totalBytes = Buffer.byteLength(content, "utf8");
	const from = Math.min(offset, content.length);
	const text = Buffer.from(content.slice(from), "utf8")
		.subarray(0, cap)
		.toString("utf8")
		// A cap can land mid-character; drop the partial one rather than
		// handing back a replacement glyph.
		.replace(/�$/, "");
	const end = from + text.length;
	const truncated = end < content.length;
	return {
		uri,
		label,
		text,
		truncated,
		nextOffset: truncated ? end : null,
		sizeBytes: totalBytes,
	};
}

export interface SearchHit {
	uri: string;
	label: string;
	line: number;
	text: string;
}

/**
 * Case-insensitive substring search across the exposed files.
 *
 * Not regex: a tool an agent can get wrong in fifty ways is a tool that
 * reports "no matches" when it means "bad pattern".
 */
export async function searchExposed(
	deps: McpDeps,
	ctx: McpContext,
	needle: string,
	max: number,
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
	const target = needle.toLowerCase();
	const hits: SearchHit[] = [];
	let truncated = false;
	for (const file of await listExposedFiles(deps, ctx)) {
		if (hits.length >= max) {
			truncated = true;
			break;
		}
		const content = await readWhole(deps, ctx, file).catch(() => null);
		if (content === null) {
			continue;
		}
		const lines = content.split("\n");
		for (const [index, line] of lines.entries()) {
			if (!line.toLowerCase().includes(target)) {
				continue;
			}
			if (hits.length >= max) {
				truncated = true;
				break;
			}
			hits.push({
				uri: file.uri,
				label: file.label,
				line: index + 1,
				// Trimmed and capped: a minified line should not be the answer.
				text: line.trim().slice(0, 300),
			});
		}
	}
	return { hits, truncated };
}

/** Whole content for searching, which is not the same as for reading. */
async function readWhole(
	deps: McpDeps,
	ctx: McpContext,
	file: ExposedFile,
): Promise<string> {
	const parsed = parseUri(file.uri);
	if (parsed.kind === "doc") {
		const document = await deps.documents.getDocument(
			ctx.workspace.id,
			parsed.id,
		);
		return document.content;
	}
	const root = await pathRootFor(deps, ctx, parsed.id);
	const { content } = await readTextFile(root.root, parsed.relative);
	return content;
}

export interface DomainSummary {
	name: string;
	description: string;
	objects: string[];
}

/**
 * The domain map for one datasource: which objects belong to which part
 * of the product (docs/spec/domains.md).
 *
 * This is the knowledge `information_schema` cannot hold. "Which of
 * these forty tables are billing" is a question about the product, and
 * somebody in this project already answered it.
 *
 * Hidden domains are left out, exactly as the export leaves them out —
 * an engine built-in or a plugin's debris is not part of the layout.
 */
export async function domainMap(
	deps: McpDeps,
	ctx: McpContext,
	connectionRef: string,
): Promise<DomainSummary[]> {
	const { domains, tags } = await listDomains(
		deps.appDb,
		ctx.workspace.id,
		connectionRef,
	);
	return domains
		.filter((domain) => !domain.hidden)
		.map((domain) => ({
			name: domain.name,
			description: domain.description,
			objects: tags
				.filter((tag) => tag.domainId === domain.id)
				.map(
					(tag) => `${tag.target.kind} ${tag.target.schema}.${tag.target.name}`,
				),
		}));
}

/** Capability words an agent should not have to discover by failing. */
export function capabilitiesOf(datasource: ConnectionMetadata): {
	sql: boolean;
	introspection: string | null;
	dialect: string | null;
} {
	const capabilities = ADAPTER_CAPABILITIES[datasource.adapter];
	return {
		sql: capabilities.execution !== null,
		introspection: capabilities.introspection,
		dialect: capabilities.sqlDialect ?? null,
	};
}
