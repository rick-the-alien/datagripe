import type {
	Document,
	DocumentCreateRequest,
	DocumentListEntry,
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
	updated_at: string | Date;
};

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
		updatedAt: new Date(row.updated_at).toISOString(),
	};
}

export interface DocumentsService {
	listDocuments: (workspaceId: string) => Promise<DocumentListEntry[]>;
	getDocument: (workspaceId: string, id: string) => Promise<Document>;
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

	return {
		async listDocuments(workspaceId) {
			const rows = await appDb<DocumentRow[]>`
				SELECT id, title, revision, updated_at, workspace_id, content,
					default_connection_id
				FROM documents
				WHERE workspace_id = ${workspaceId} AND archived_at IS NULL
				ORDER BY created_at
			`;
			return rows.map((row) => ({
				id: row.id,
				title: row.title,
				revision: row.revision,
				updatedAt: new Date(row.updated_at).toISOString(),
			}));
		},

		async getDocument(workspaceId, id) {
			return rowToDocument(await getRow(workspaceId, id));
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
			return {
				id: row.id,
				title: row.title,
				revision: row.revision,
				updatedAt: new Date(row.updated_at).toISOString(),
			};
		},
	};
}
