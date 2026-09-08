import type { ConnectionMetadata } from "@datagripe/contracts";
import type { EditorDocument } from "./documents";
import { useDocumentsStore } from "./documents";

/**
 * Open a file named the way git names it — relative to the work tree
 * root — through the datasource-path machinery, which names files
 * relative to a configured directory (docs/spec/git-datasources.md
 * "The repository section").
 *
 * The two vocabularies meet here and nowhere else. A repository row that
 * falls outside every configured path is not openable and says nothing
 * rather than opening the wrong file: the sidebar can only reach what
 * `config.yaml` put in it.
 */

/** POSIX-join, because git speaks POSIX whatever the host does. */
function joinPosix(parent: string, child: string): string {
	return parent === "" ? child : `${parent.replace(/\/+$/, "")}/${child}`;
}

/** `child` relative to `parent`, or null when it is not underneath it. */
export function relativeUnder(parent: string, child: string): string | null {
	const normalise = (value: string) =>
		value.replaceAll("\\", "/").replace(/\/+$/, "");
	const from = normalise(parent);
	const to = normalise(child);
	if (to === from) {
		return "";
	}
	// Segment-wise, so `/srv/repo-evil` is not under `/srv/repo`.
	return to.startsWith(`${from}/`) ? to.slice(from.length + 1) : null;
}

/**
 * Which configured path holds a repo-relative file, and what it is
 * called inside it.
 */
export function locateInPaths(
	connection: ConnectionMetadata,
	repoPath: string,
	repoRelative: string,
): { pathId: string; filePath: string } | null {
	const absolute = joinPosix(repoPath, repoRelative);
	// Longest configured path first: a nested pair should win over the
	// checkout-wide one that also contains it.
	const ordered = [...connection.paths].sort(
		(a, b) => b.path.length - a.path.length,
	);
	for (const entry of ordered) {
		const inside = relativeUnder(entry.path, absolute);
		if (inside !== null && inside !== "") {
			return { pathId: entry.id, filePath: inside };
		}
	}
	return null;
}

export async function openRepoFile(
	connection: ConnectionMetadata,
	repoPath: string,
	repoRelative: string,
): Promise<EditorDocument | null> {
	const located = locateInPaths(connection, repoPath, repoRelative);
	if (located === null) {
		return null;
	}
	return useDocumentsStore.getState().openFile({
		connectionRef: connection.id,
		pathId: located.pathId,
		filePath: located.filePath,
	});
}
