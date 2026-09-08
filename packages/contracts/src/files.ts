import { z } from "zod";
import { documentSchema } from "./documents";

/**
 * Datasource paths — project directories browsed in the sidebar
 * (docs/spec/datasource-paths.md).
 *
 * A datasource usually has a checkout somewhere: the migrations that
 * built it, the queries the team keeps, the dump the sync tab writes.
 * A path pair names one of those directories, and the sidebar gives it
 * its own section above the workspace files whenever that datasource is
 * the active one.
 *
 * Like the export directory, this is workspace-local configuration
 * *about* a datasource rather than part of its definition — which is why
 * a predefined connection can carry paths while the rest of it stays
 * read-only.
 */

/** The section title in the sidebar. Short: it sits in a 240px rail. */
export const datasourcePathNameSchema = z.string().min(1).max(60);

export const datasourcePathSchema = z.object({
	id: z.uuid(),
	name: datasourcePathNameSchema,
	/** Absolute directory on the host the server runs on. */
	path: z.string().min(1).max(1024),
});

export type DatasourcePath = z.infer<typeof datasourcePathSchema>;

/**
 * Replace the whole list for one datasource. A whole-list write rather
 * than per-row add/remove actions because the form edits them as a list
 * and saves once with the rest of it — a half-applied list is a state
 * nobody asked for.
 */
export const datasourcePathsSetRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	paths: z
		.array(
			z.object({
				/** Omitted for a row added in the form; the server assigns one. */
				id: z.uuid().optional(),
				name: datasourcePathNameSchema,
				path: z.string().min(1).max(1024),
			}),
		)
		.max(20),
	idempotencyKey: z.string().min(8).max(128),
});

export type DatasourcePathsSetRequest = z.infer<
	typeof datasourcePathsSetRequestSchema
>;

/** Ask whether a directory is readable and allowed, without saving. */
export const hostPathCheckRequestSchema = z.object({
	path: z.string().max(1024),
});

export type HostPathCheckRequest = z.infer<typeof hostPathCheckRequestSchema>;

export const hostPathCheckSchema = z.object({
	ok: z.boolean(),
	/** The resolved absolute path when it is allowed. */
	resolved: z.string().nullable(),
	/** Why not, in one sentence, when it is not. */
	message: z.string(),
});

export type HostPathCheck = z.infer<typeof hostPathCheckSchema>;

/**
 * One directory entry. Deliberately thin: the tree shows a name and a
 * glyph, and anything more is a stat call per row on every expand.
 */
export const fileEntrySchema = z.object({
	name: z.string(),
	kind: z.enum(["dir", "file"]),
	/** Bytes; null for directories. */
	size: z.number().int().nonnegative().nullable(),
	modifiedAt: z.iso.datetime(),
	/** A file the editor will refuse to open (binary, or over the cap). */
	openable: z.boolean(),
});

export type FileEntry = z.infer<typeof fileEntrySchema>;

/**
 * A path *inside* a configured root, always relative and always in
 * POSIX form. The empty string is the root itself. Validated again
 * server-side against the resolved root — this schema only keeps the
 * obvious mistakes off the wire.
 */
export const relativePathSchema = z
	.string()
	.max(1024)
	.refine((value) => !value.startsWith("/"), "must be relative")
	.refine(
		(value) => !value.split("/").includes(".."),
		"must not climb out of the root",
	);

export const fileListRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	pathId: z.uuid(),
	/** Directory to list, relative to the configured root. */
	subPath: relativePathSchema.default(""),
});

export type FileListRequest = z.infer<typeof fileListRequestSchema>;

export const fileListResultSchema = z.object({
	/** Directories first, then files; each group name-sorted. */
	entries: z.array(fileEntrySchema),
});

export type FileListResult = z.infer<typeof fileListResultSchema>;

/**
 * Open a file as a workspace document.
 *
 * The document is cached in the app database, so a file opened from a
 * path gets the same live multiplayer state as any other shared file —
 * presence, followed cursors, revision-guarded saves. The file on disk
 * stays the artifact: every save writes it back.
 *
 * No idempotency key: one live document per file is a unique index, so
 * opening twice — or two people opening at once — lands on the same row
 * by construction rather than by remembering a request.
 */
export const fileOpenRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	pathId: z.uuid(),
	filePath: relativePathSchema,
});

export type FileOpenRequest = z.infer<typeof fileOpenRequestSchema>;

export const fileOpenResultSchema = z.object({
	document: documentSchema,
	/**
	 * The file changed on disk since DataGripe last synced it *and* the
	 * cached copy has edits of its own, so neither could be adopted
	 * silently. The editor offers reload-from-disk or keep-mine.
	 */
	diskChanged: z.boolean(),
	/** What is on disk right now, present only when `diskChanged`. The
	 * editor needs both versions in hand to offer a choice between them. */
	diskContent: z.string().nullable(),
});

export type FileOpenResult = z.infer<typeof fileOpenResultSchema>;
