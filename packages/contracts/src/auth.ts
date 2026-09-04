import { z } from "zod";

/** Authentication and workspace-membership contracts (ADR 0002). */

export const workspaceRoleSchema = z.enum(["owner", "editor", "viewer"]);

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const sessionUserSchema = z.object({
	id: z.uuid(),
	email: z.string().email(),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

/** GET /api/session bootstrap response. */
export const sessionBootstrapSchema = z.object({
	user: sessionUserSchema.nullable(),
	workspace: z
		.object({
			id: z.uuid(),
			name: z.string(),
			role: workspaceRoleSchema,
			defaultConnectionRef: z.string().nullable(),
		})
		.nullable(),
	csrfToken: z.string().nullable(),
	wsUrl: z.string(),
	/** True while zero users exist — show the bootstrap signup form. */
	bootstrap: z.boolean(),
	allowSignup: z.boolean(),
	/** True when the server runs without accounts (embedded local mode):
	 * the session is implicit and login/signup/logout do not exist. */
	authDisabled: z.boolean(),
});

export type SessionBootstrap = z.infer<typeof sessionBootstrapSchema>;

export const loginRequestSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1).max(1024),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const signupRequestSchema = z.object({
	email: z.string().email(),
	password: z.string().min(12).max(1024),
});

export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const workspaceMemberSchema = z.object({
	userId: z.uuid(),
	email: z.string().email(),
	role: workspaceRoleSchema,
	since: z.iso.datetime(),
});

export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const workspaceMembersResultSchema = z.object({
	members: z.array(workspaceMemberSchema),
});

export type WorkspaceMembersResult = z.infer<
	typeof workspaceMembersResultSchema
>;

export const memberAddRequestSchema = z.object({
	email: z.string().email(),
	role: z.enum(["editor", "viewer"]),
});

export type MemberAddRequest = z.infer<typeof memberAddRequestSchema>;

export const memberRemoveRequestSchema = z.object({
	userId: z.uuid(),
});

export type MemberRemoveRequest = z.infer<typeof memberRemoveRequestSchema>;

/** Workspace creation and listing (workspaces are the project unit). */
export const workspaceCreateRequestSchema = z.object({
	name: z.string().min(1).max(255),
});

export type WorkspaceCreateRequest = z.infer<
	typeof workspaceCreateRequestSchema
>;

export const workspaceListEntrySchema = z.object({
	id: z.uuid(),
	name: z.string().min(1).max(255),
	role: workspaceRoleSchema,
});

export type WorkspaceListEntry = z.infer<typeof workspaceListEntrySchema>;

export const workspaceListResultSchema = z.object({
	workspaces: z.array(workspaceListEntrySchema),
});

export type WorkspaceListResult = z.infer<typeof workspaceListResultSchema>;

export const workspaceSetDefaultConnectionRequestSchema = z.object({
	/** Managed UUID, "predefined:<slug>", or null to clear. */
	connectionRef: z.string().min(1).max(255).nullable(),
});

export type WorkspaceSetDefaultConnectionRequest = z.infer<
	typeof workspaceSetDefaultConnectionRequestSchema
>;
