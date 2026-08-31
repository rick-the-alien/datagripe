import { z } from "zod";

/** Multiplayer contracts (docs/spec/multiplayer.md). */

/** — 6a: shared files — */

/** Save gains an optional title (rename) and force (keep-mine on 409). */
export const documentArchiveRequestSchema = z.object({
	id: z.uuid(),
	idempotencyKey: z.string().min(8).max(128),
});

export type DocumentArchiveRequest = z.infer<
	typeof documentArchiveRequestSchema
>;

export const documentGetRequestSchema = z.object({
	id: z.uuid(),
});

export type DocumentGetRequest = z.infer<typeof documentGetRequestSchema>;

/** Document metadata as listed by workspace.open (no content). */
export const documentListEntrySchema = z.object({
	id: z.uuid(),
	title: z.string().min(1).max(255),
	revision: z.number().int().nonnegative(),
	updatedAt: z.iso.datetime(),
});

export type DocumentListEntry = z.infer<typeof documentListEntrySchema>;

/** — 6b: presence — */

export const documentFocusRequestSchema = z.object({
	documentId: z.uuid().nullable(),
});

export type DocumentFocusRequest = z.infer<typeof documentFocusRequestSchema>;

export const presenceUserSchema = z.object({
	userId: z.uuid(),
	email: z.string().email(),
	activeDocumentId: z.uuid().nullable(),
	lastSeenAt: z.iso.datetime(),
});

export type PresenceUser = z.infer<typeof presenceUserSchema>;

export const presenceUpdatePayloadSchema = z.object({
	users: z.array(presenceUserSchema),
});

export type PresenceUpdatePayload = z.infer<typeof presenceUpdatePayloadSchema>;

/** — 6c: shared views — */

export const cursorPositionSchema = z.object({
	line: z.number().int().positive(),
	column: z.number().int().positive(),
});

export const viewStatePayloadSchema = z.object({
	userId: z.uuid(),
	documentId: z.uuid(),
	cursor: cursorPositionSchema,
	selection: z
		.object({
			startLine: z.number().int().positive(),
			startColumn: z.number().int().positive(),
			endLine: z.number().int().positive(),
			endColumn: z.number().int().positive(),
		})
		.nullable(),
	scrollTop: z.number().nonnegative(),
});

export type ViewStatePayload = z.infer<typeof viewStatePayloadSchema>;

export const viewBroadcastRequestSchema = z.object({
	documentId: z.uuid(),
	cursor: cursorPositionSchema,
	selection: z
		.object({
			startLine: z.number().int().positive(),
			startColumn: z.number().int().positive(),
			endLine: z.number().int().positive(),
			endColumn: z.number().int().positive(),
		})
		.nullable(),
	scrollTop: z.number().nonnegative(),
});

export type ViewBroadcastRequest = z.infer<typeof viewBroadcastRequestSchema>;

export const viewFollowRequestSchema = z.object({
	userId: z.uuid(),
});

export type ViewFollowRequest = z.infer<typeof viewFollowRequestSchema>;

/** Notifies the followed member that someone is following their view. */
export const viewFollowedPayloadSchema = z.object({
	followerUserId: z.uuid(),
	following: z.boolean(),
});

export type ViewFollowedPayload = z.infer<typeof viewFollowedPayloadSchema>;

/** — 6d: shared execution — */

export const historyScopeSchema = z.enum(["mine", "workspace"]);

export type HistoryScope = z.infer<typeof historyScopeSchema>;
