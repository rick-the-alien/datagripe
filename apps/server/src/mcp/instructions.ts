import type { ConnectionMetadata } from "@datagripe/contracts";
import { readTextFile } from "../files/browse";
import type { McpContext, McpDeps } from "./context";
import { datasources } from "./knowledge";

/**
 * The briefing (docs/spec/mcp.md "The briefing").
 *
 * `initialize` returns this, and every client hands it to the model
 * before the first tool call — which makes it the highest-leverage
 * string in the feature. A project that has written down how its
 * database works gets to say so once, rather than hoping an agent
 * infers it from column names.
 */

/** The workspace file that becomes the briefing when no repo names one. */
const CONVENTION_TITLES = ["agents.md", "claude.md"];

export interface Briefing {
	text: string;
	/** Where the prose came from, for the panel. Null = ours alone. */
	source: string | null;
}

export async function buildBriefing(
	deps: McpDeps,
	ctx: McpContext,
): Promise<Briefing> {
	const list = await datasources(deps, ctx);
	const found = await findProse(deps, ctx, list);
	const cap = deps.config.MCP_INSTRUCTIONS_MAX_BYTES;
	const header = ourWords(ctx, list, found?.source ?? null);
	if (found === null) {
		return { text: header, source: null };
	}
	// Ours first, the project's after. Truncation eats the tail, and the
	// sentence about what this mode does must not be the part that gets
	// eaten — nor may a file somebody edited be the thing that describes
	// a read-only project as writable.
	const room = Math.max(0, cap - Buffer.byteLength(header, "utf8") - 200);
	const body = Buffer.from(found.text, "utf8")
		.subarray(0, room)
		.toString("utf8");
	const truncated = body.length < found.text.length;
	return {
		text: [
			header,
			"",
			`--- ${found.source} ---`,
			body.replace(/�$/, ""),
			...(truncated
				? ["", `[truncated — read ${found.uri} with read_doc for the rest]`]
				: []),
		].join("\n"),
		source: found.source,
	};
}

function ourWords(
	ctx: McpContext,
	list: ConnectionMetadata[],
	source: string | null,
): string {
	const lines = [
		`You are connected to the DataGripe project '${ctx.workspace.name}'.`,
		"",
		ctx.mode === "read-only"
			? "This MCP server is READ-ONLY. Queries run inside a read-only transaction that is always rolled back, and any statement that writes is refused before it reaches the database."
			: "This MCP server is in READ/WRITE mode: a query you run commits. A datasource marked read only stays read-only regardless — that is the datasource's own setting, not this one's.",
		"",
		"Datasources:",
		...list.map(
			(entry) =>
				`- ${entry.id} — ${entry.name} (${entry.adapter}${entry.readOnly ? ", read only" : ""})${
					entry.branding?.description === null ||
					entry.branding?.description === undefined
						? ""
						: `: ${entry.branding.description}`
				}`,
		),
		"",
		"Call describe_project first: it returns the datasources, the domain map (which objects belong to which part of the product) and an index of the project's own documentation. Read those documents before guessing what a table means — they exist because the schema does not say.",
	];
	if (source !== null) {
		lines.push(
			"",
			`What follows is this project's own briefing, from ${source}.`,
		);
	}
	return lines.join("\n");
}

interface Prose {
	text: string;
	source: string;
	uri: string;
}

/**
 * `.datagripe/config.yaml` first, then a conventionally named workspace
 * file. The repository wins because it travels with the clone: somebody
 * who has just cloned the project has not written a workspace file yet.
 */
async function findProse(
	deps: McpDeps,
	ctx: McpContext,
	list: ConnectionMetadata[],
): Promise<Prose | null> {
	const git = deps.gitDatasources;
	if (git !== undefined) {
		for (const datasource of list) {
			const entry = await git.entryFor(ctx.workspace.id, datasource.id);
			const named = entry?.config.mcp?.instructions;
			if (entry === null || entry === undefined || named === undefined) {
				continue;
			}
			// `readTextFile` resolves the name inside the work tree and
			// proves it with realpath, so a committed symlink pointing at
			// /etc is caught here rather than followed — the same
			// containment every other repo-declared path goes through.
			const read = await readTextFile(entry.repoPath, named).catch(() => null);
			if (read !== null) {
				return {
					text: read.content,
					source: `${datasource.name}: ${named}`,
					uri: named,
				};
			}
		}
	}
	const documents = await deps.documents.listDocuments(ctx.workspace.id);
	const conventional = documents.find((entry) =>
		CONVENTION_TITLES.includes(entry.title.toLowerCase()),
	);
	if (conventional === undefined) {
		return null;
	}
	const document = await deps.documents.getDocument(
		ctx.workspace.id,
		conventional.id,
	);
	return {
		text: document.content,
		source: `workspace file ${document.title}`,
		uri: `datagripe://doc/${document.id}`,
	};
}
