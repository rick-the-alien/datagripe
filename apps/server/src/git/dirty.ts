import path from "node:path";
import type { AppDb } from "../db/app/pool";
import { hashContent } from "../files/browse";

/**
 * Which of a datasource's cached files are ahead of their file on disk
 * (docs/spec/git-datasources.md "After a pull").
 *
 * "Dirty" server-side is not the editor's dirty dot: it is the document
 * row's content differing from `disk_content_hash`, the bytes DataGripe
 * last read from or wrote to the file. That is the state a fast-forward
 * would destroy, and it is the only one the server can actually see.
 *
 * Returned repo-relative, because that is what `git diff --name-only`
 * speaks and the caller is intersecting the two lists.
 */
export async function dirtyOriginPaths(
	appDb: AppDb,
	workspaceId: string,
	connectionRef: string,
	repoRoot: string,
): Promise<string[]> {
	const rows = await appDb<
		Array<{
			content: string;
			disk_content_hash: string | null;
			origin_file_path: string;
			path: string;
		}>
	>`
		SELECT d.content, d.disk_content_hash, d.origin_file_path, p.path
		FROM documents d
		JOIN datasource_paths p ON p.id = d.origin_path_id
		WHERE d.workspace_id = ${workspaceId}
			AND d.origin_connection_ref = ${connectionRef}
			AND d.archived_at IS NULL
	`;
	const dirty: string[] = [];
	for (const row of rows) {
		if (
			row.disk_content_hash !== null &&
			hashContent(row.content) === row.disk_content_hash
		) {
			continue; // in sync with its file
		}
		const absolute = path.resolve(row.path, row.origin_file_path);
		const relative = path.relative(repoRoot, absolute);
		if (relative !== "" && !relative.startsWith("..")) {
			dirty.push(relative.split(path.sep).join("/"));
		}
	}
	return dirty;
}
