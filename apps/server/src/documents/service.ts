import type {
	Document,
	DocumentCreateRequest,
	DocumentListEntry,
	DocumentOrigin,
	DocumentSaveRequest,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import type { AppDb } from "../db/app/pool";

/**
 * Workspace-scoped document storage (docs/spec/multiplayer.md 6a). Every
 * member may read; editors/owners write (role gate lives in dispatch).
 * Saves are revision-guarded: a mismatch returns CONFLICT with the
 * current document so the client can offer reload/keep-mine.
 */

export class DocumentConflictError extends ServiceError {
	readonly current: Document;

	constructor(current: Document) {
		super(
			ErrorCodes.Conflict,
			`Document was saved elsewhere (server revision ${current.revision})`,
		);
		this.name = "DocumentConflictError";
		this.current = current;
	}
}

type DocumentRow = {
	id: string;
	workspace_id: string;
	title: string;
	content: string;
	revision: number;
	default_connection_id: string | null;
	origin_connection_ref: string | null;
	origin_path_id: string | null;
	origin_file_path: string | null;
	disk_content_hash: string | null;
	updated_at: string | Date;
};

/** The three origin columns move together (see the table CHECK). */
function rowToOrigin(row: DocumentRow): DocumentOrigin | null {
	if (
		row.origin_connection_ref === null ||
		row.origin_path_id === null ||
		row.origin_file_path === null
	) {
		return null;
	}
	return {
		connectionRef: row.origin_connection_ref,
		pathId: row.origin_path_id,
		filePath: row.origin_file_path,
	};
}

function rowToDocument(row: DocumentRow): Document {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		title: row.title,
		language: "sql",
		content: row.content,
		revision: row.revision,
		...(row.default_connection_id !== null
			? { defaultConnectionId: row.default_connection_id }
			: {}),
		origin: rowToOrigin(row),
		updatedAt: new Date(row.updated_at).toISOString(),
	};
}

function rowToEntry(row: DocumentRow): DocumentListEntry {
	return {
		id: row.id,
		title: row.title,
		revision: row.revision,
		updatedAt: new Date(row.updated_at).toISOString(),
		origin: rowToOrigin(row),
	};
}

/** What DataGripe last read from / wrote to the file, for `file.open`. */
export interface DiskSyncState {
	hash: string | null;
}

export interface FileDocumentCreate {
	origin: DocumentOrigin;
	title: string;
	content: string;
	/** Hash of the bytes just read off disk. */
	diskHash: string;
}

export interface DocumentsService {
	listDocuments: (workspaceId: string) => Promise<DocumentListEntry[]>;
	getDocument: (workspaceId: string, id: string) => Promise<Document>;
	/** The cached document for one file, or null if it was never opened. */
	getDocumentByOrigin: (
		workspaceId: string,
		pathId: string,
		filePath: string,
	) => Promise<Document | null>;
	/** Cache a file as a workspace document on its first open. */
	createFileDocument: (
		workspaceId: string,
		request: FileDocumentCreate,
	) => Promise<Document>;
	/** What was last synced to disk, for the changed-underneath-us check. */
	diskSyncState: (workspaceId: string, id: string) => Promise<DiskSyncState>;
	/** Record that the document and the file now hold the same bytes. */
	markDiskSynced: (id: string, hash: string) => Promise<void>;
	/** Replace content from disk, as a new revision (reload-from-disk). */
	adoptFromDisk: (
		workspaceId: string,
		id: string,
		content: string,
		hash: string,
	) => Promise<Document>;
	createDocument: (
		workspaceId: string,
		request: DocumentCreateRequest,
	) => Promise<Document>;
	saveDocument: (
		workspaceId: string,
		request: DocumentSaveRequest,
	) => Promise<Document>;
	archiveDocument: (
		workspaceId: string,
		id: string,
	) => Promise<DocumentListEntry>;
}

export function createDocumentsService(appDb: AppDb): DocumentsService {
	async function getRow(workspaceId: string, id: string): Promise<DocumentRow> {
		const rows = await appDb<DocumentRow[]>`
			SELECT * FROM documents
			WHERE id = ${id} AND workspace_id = ${workspaceId} AND archived_at IS NULL
		`;
		const row = rows[0];
		if (row === undefined) {
			throw new ServiceError(ErrorCodes.NotFound, `Document '${id}' not found`);
		}
		return row;
	}

	async function findByOrigin(
		workspaceId: string,
		pathId: string,
		filePath: string,
	): Promise<Document | null> {
		const rows = await appDb<DocumentRow[]>`
			SELECT * FROM documents
			WHERE workspace_id = ${workspaceId}
				AND origin_path_id = ${pathId}
				AND origin_file_path = ${filePath}
				AND archived_at IS NULL
		`;
		const row = rows[0];
		return row === undefined ? null : rowToDocument(row);
	}

	return {
		async listDocuments(workspaceId) {
			const rows = await appDb<DocumentRow[]>`
				SELECT id, title, revision, updated_at, workspace_id, content,
					default_connection_id, origin_connection_ref, origin_path_id,
					origin_file_path, disk_content_hash
				FROM documents
				WHERE workspace_id = ${workspaceId} AND archived_at IS NULL
				ORDER BY created_at
			`;
			return rows.map(rowToEntry);
		},

		async getDocument(workspaceId, id) {
			return rowToDocument(await getRow(workspaceId, id));
		},

		getDocumentByOrigin: findByOrigin,

		async createFileDocument(workspaceId, request) {
			const rows = await appDb<DocumentRow[]>`
				INSERT INTO documents (
					workspace_id, title, content, origin_connection_ref,
					origin_path_id, origin_file_path, disk_content_hash,
					disk_synced_at
				) VALUES (
					${workspaceId}, ${request.title}, ${request.content},
					${request.origin.connectionRef}, ${request.origin.pathId},
					${request.origin.filePath}, ${request.diskHash}, now()
				)
				-- Two people opening the same file at the same moment must
				-- land on one row, not two caches of one file.
				ON CONFLICT DO NOTHING
				RETURNING *
			`;
			const row = rows[0];
			if (row !== undefined) {
				return rowToDocument(row);
			}
			const existing = await findByOrigin(
				workspaceId,
				request.origin.pathId,
				request.origin.filePath,
			);
			if (existing === null) {
				throw new ServiceError(ErrorCodes.Internal, "Insert returned no row");
			}
			return existing;
		},

		async diskSyncState(workspaceId, id) {
			const row = await getRow(workspaceId, id);
			return { hash: row.disk_content_hash };
		},

		async markDiskSynced(id, hash) {
			await appDb`
				UPDATE documents
				SET disk_content_hash = ${hash}, disk_synced_at = now()
				WHERE id = ${id}
			`;
		},

		async adoptFromDisk(workspaceId, id, content, hash) {
			await getRow(workspaceId, id);
			const rows = await appDb<DocumentRow[]>`
				UPDATE documents SET
					content = ${content},
					revision = revision + 1,
					disk_content_hash = ${hash},
					disk_synced_at = now(),
					updated_at = now()
				WHERE id = ${id}
				RETURNING *
			`;
			const row = rows[0];
			if (row === undefined) {
				throw new ServiceError(ErrorCodes.Internal, "Update returned no row");
			}
			return rowToDocument(row);
		},

		async createDocument(workspaceId, request) {
			const rows = await appDb<DocumentRow[]>`
				INSERT INTO documents (${request.id !== undefined ? appDb`id, ` : appDb``}workspace_id, title, content)
				VALUES (${request.id !== undefined ? appDb`${request.id}, ` : appDb``}${workspaceId}, ${request.title}, ${request.content})
				ON CONFLICT (id) DO NOTHING
				RETURNING *
			`;
			// ON CONFLICT DO NOTHING + RETURNING yields no row on replay.
			const row =
				rows[0] ??
				(request.id !== undefined
					? await getRow(workspaceId, request.id)
					: undefined);
			if (row === undefined) {
				throw new ServiceError(ErrorCodes.Internal, "Insert returned no row");
			}
			return rowToDocument(row);
		},

		async saveDocument(workspaceId, request) {
			const current = await getRow(workspaceId, request.id);
			if (current.revision !== request.revision && !request.force) {
				throw new DocumentConflictError(rowToDocument(current));
			}
			const rows = await appDb<DocumentRow[]>`
				UPDATE documents SET
					content = ${request.content},
					revision = revision + 1,
					updated_at = now()
					${request.title !== undefined ? appDb`, title = ${request.title}` : appDb``}
				WHERE id = ${request.id}
				RETURNING *
			`;
			const row = rows[0];
			if (row === undefined) {
				throw new ServiceError(ErrorCodes.Internal, "Update returned no row");
			}
			return rowToDocument(row);
		},

		async archiveDocument(workspaceId, id) {
			const rows = await appDb<DocumentRow[]>`
				UPDATE documents SET archived_at = now()
				WHERE id = ${id} AND workspace_id = ${workspaceId} AND archived_at IS NULL
				RETURNING *
			`;
			const row = rows[0];
			if (row === undefined) {
				throw new ServiceError(
					ErrorCodes.NotFound,
					`Document '${id}' not found`,
				);
			}
			return rowToEntry(row);
		},
	};
}
