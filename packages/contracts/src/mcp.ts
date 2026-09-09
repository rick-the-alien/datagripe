import { z } from "zod";

/**
 * MCP server settings and tokens (docs/spec/mcp.md).
 *
 * The wire shape of the protocol itself is not here: JSON-RPC envelopes,
 * tool definitions and tool results never reach the browser, so they
 * live in `apps/server/src/mcp/`. What crosses this boundary is what the
 * sidebar panel shows and changes.
 */

/**
 * Read-only is the default and the mode a project stays in until
 * somebody presses the other one. It is a ceiling, not a grant: a
 * datasource whose own `read only` setting is on stays read-only over
 * MCP however this is set.
 */
export const mcpModeSchema = z.enum(["read-only", "read-write"]);

export type McpMode = z.infer<typeof mcpModeSchema>;

/** Short: it names a client, and it sits in a 240px rail. */
export const mcpTokenNameSchema = z.string().min(1).max(60);

/**
 * One minted token. The value is absent because it is hashed at rest and
 * shown exactly once, at creation.
 */
export const mcpTokenSchema = z.object({
	id: z.uuid(),
	name: mcpTokenNameSchema,
	/** Whose access this token delegates. */
	createdBy: z.string(),
	createdAt: z.iso.datetime(),
	/** Null until an agent has used it. */
	lastUsedAt: z.iso.datetime().nullable(),
});

export type McpToken = z.infer<typeof mcpTokenSchema>;

/** A datasource as the panel lists it, so read/write can be honest. */
export const mcpDatasourceSchema = z.object({
	ref: z.string().min(1).max(255),
	name: z.string().min(1).max(255),
	/** The datasource's own setting, which the mode cannot override. */
	readOnly: z.boolean(),
});

export type McpDatasource = z.infer<typeof mcpDatasourceSchema>;

/** Everything the panel renders, in one read. */
export const mcpStateSchema = z.object({
	/**
	 * `MCP_ENABLED`. False means the route is not mounted and the panel
	 * is absent — this field exists so the client knows which, rather
	 * than rendering a switch that cannot work.
	 */
	available: z.boolean(),
	enabled: z.boolean(),
	mode: mcpModeSchema,
	/** Endpoint for this project, including the project id. */
	url: z.string(),
	updatedAt: z.iso.datetime().nullable(),
	tokens: z.array(mcpTokenSchema),
	datasources: z.array(mcpDatasourceSchema),
	/** Exposed files: workspace documents plus every path pair's tree. */
	fileCount: z.number().int().nonnegative(),
	/** Where the briefing came from, in words, or null for the default. */
	instructionsSource: z.string().nullable(),
});

export type McpState = z.infer<typeof mcpStateSchema>;

export const mcpSettingsSetRequestSchema = z.object({
	enabled: z.boolean(),
	mode: mcpModeSchema,
});

export type McpSettingsSetRequest = z.infer<typeof mcpSettingsSetRequestSchema>;

export const mcpTokenCreateRequestSchema = z.object({
	name: mcpTokenNameSchema,
});

export type McpTokenCreateRequest = z.infer<typeof mcpTokenCreateRequestSchema>;

export const mcpTokenCreateResultSchema = z.object({
	token: mcpTokenSchema,
	/**
	 * The plaintext value, this once. Never stored, never returned again,
	 * and the panel says so beside it.
	 */
	value: z.string(),
	state: mcpStateSchema,
});

export type McpTokenCreateResult = z.infer<typeof mcpTokenCreateResultSchema>;

export const mcpTokenRevokeRequestSchema = z.object({
	id: z.uuid(),
});

export type McpTokenRevokeRequest = z.infer<typeof mcpTokenRevokeRequestSchema>;

/** Prefix on every token value, so a leaked one is recognisable. */
export const MCP_TOKEN_PREFIX = "dgm_";

/**
 * The protocol revision we implement. A client asking for a different
 * one gets ours back rather than a refusal: the methods here are the
 * stable core of every revision so far.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
