import { z } from "zod";
import { adapterInfoSchema, connectionAdapterSchema } from "./adapters";
import { workspaceRoleSchema } from "./auth";
import { datasourcePathSchema } from "./files";
import { documentListEntrySchema } from "./multiplayer";

/** Connection contracts. Secrets are write-only; never serialized back to clients. */

export type { AdapterDialect, ConnectionAdapter } from "./adapters";

/**
 * The `sslmode` values this driver can actually honour, in ascending
 * strictness.
 *
 * `verify-ca` joins the original three because it is a real distinction
 * somebody chooses deliberately — the chain must validate but the
 * hostname need not match, which is what a certificate issued for an
 * internal name behind a load balancer needs — and Bun's `tls` option
 * takes libpq's spellings verbatim, so it costs nothing to pass along.
 *
 * libpq's other two, `allow` and `prefer`, are deliberately absent.
 * Measured against a non-TLS PostgreSQL on Bun 1.4: `disable` connects,
 * `require`/`verify-ca`/`verify-full` fail immediately with "Server does
 * not support SSL", and `allow` and `prefer` **hang until the connection
 * timeout**. There is no negotiated fallback behind them, so offering
 * either would be offering a setting whose only behaviour is a ten-second
 * stall. A pasted `?sslmode=prefer` is raised to `require` instead, and
 * the user is told: failing visibly beats quietly not encrypting.
 */
export const tlsModeSchema = z.enum([
	"disable",
	"require",
	"verify-ca",
	"verify-full",
]);

export type TlsMode = z.infer<typeof tlsModeSchema>;

/**
 * `git` is a datasource whose definition is read from a repository's
 * `.datagripe/` directory (docs/spec/git-datasources.md). Like
 * `predefined` it is read-only in the UI — you change it by editing the
 * file — but unlike `predefined` it is added at runtime, per workspace.
 */
export const connectionSourceSchema = z.enum(["managed", "predefined", "git"]);

export type ConnectionSource = z.infer<typeof connectionSourceSchema>;

/** Safe connection metadata — what the browser may see. */
export const connectionMetadataSchema = z.object({
	/** Managed connections use UUIDs; predefined use kebab-case slugs. */
	id: z.string().min(1).max(255),
	workspaceId: z.uuid(),
	name: z.string().min(1).max(255),
	adapter: connectionAdapterSchema,
	/** Null for file-based adapters (SQLite). */
	host: z.string().min(1).max(255).nullable(),
	port: z.number().int().min(1).max(65535).nullable(),
	/** Database name, file path (SQLite), or DB index (Redis). */
	databaseName: z.string().min(1).max(1024),
	username: z.string().max(255).nullable(),
	tlsMode: tlsModeSchema.nullable(),
	readOnly: z.boolean(),
	/** Tree shows every schema as an expandable level instead of scoping
	 * to the single namespace picked in the breadcrumb. */
	showAllSchemas: z.boolean(),
	/**
	 * Where this datasource's domain dump is written
	 * (docs/spec/domains.md). Per datasource rather than per project,
	 * because an export never crosses a datasource boundary — one path
	 * per project would have two datasources overwriting each other's
	 * tree.
	 *
	 * Workspace-local configuration *about* a datasource rather than part
	 * of its definition, which is why a predefined connection can carry
	 * one while everything else about it stays read-only.
	 */
	domainExportPath: z.string().nullable(),
	/**
	 * Project directories this datasource brings with it
	 * (docs/spec/datasource-paths.md) — each one becomes a sidebar
	 * section above the workspace files while it is the active
	 * datasource. Same nature as `domainExportPath`: workspace-local
	 * configuration about a datasource, so a predefined connection can
	 * carry them too.
	 */
	paths: z.array(datasourcePathSchema).default([]),
	source: connectionSourceSchema,
	/**
	 * Optional presentation from a repo's `config.yaml` `branding` block
	 * (docs/spec/git-datasources.md), so prod does not look like staging.
	 * Null for everything else.
	 */
	branding: z
		.object({
			/** One of the eight palette slots domains use; never a hex value. */
			colour: z.number().int().min(1).max(8).nullable(),
			description: z.string().nullable(),
		})
		.nullable()
		.default(null),
	/**
	 * Why this datasource cannot be connected to right now — an unset
	 * `passwordEnv`, most often. It is listed and not connectable rather
	 * than hidden: somebody who just cloned the repo needs to be told
	 * which variable to set, not left wondering why the sidebar is empty.
	 */
	unavailable: z.string().nullable().default(null),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export type ConnectionMetadata = z.infer<typeof connectionMetadataSchema>;

const connectionBaseFields = z.object({
	name: z.string().min(1).max(255),
	adapter: connectionAdapterSchema,
	host: z.string().min(1).max(255).optional(),
	port: z.number().int().min(1).max(65535).optional(),
	databaseName: z.string().min(1).max(1024),
	username: z.string().max(255).optional(),
	password: z.string().max(1024),
	tlsMode: tlsModeSchema.optional(),
	readOnly: z.boolean().default(true),
	showAllSchemas: z.boolean().default(false),
});

function checkAdapterFields(ctx: {
	value: z.infer<typeof connectionBaseFields>;
	issues: Array<Record<string, unknown>>;
}): void {
	const value = ctx.value;
	if (value.adapter === "sqlite") {
		return; // file path only; no host/port/auth fields apply
	}
	const missing: string[] = [];
	if (value.host === undefined) missing.push("host");
	if (value.port === undefined) missing.push("port");
	if (value.tlsMode === undefined) missing.push("tlsMode");
	if (value.adapter !== "redis" && value.username === undefined) {
		missing.push("username");
	}
	if (missing.length > 0) {
		ctx.issues.push({
			code: "custom",
			message: `${missing.join(", ")} required for ${value.adapter}`,
			path: ["adapter"],
			input: value,
		});
	}
}

/** Dialog-draft fields (no idempotency key). */
export const connectionDraftSchema = connectionBaseFields.check(
	checkAdapterFields as never,
);

export type ConnectionDraft = z.infer<typeof connectionDraftSchema>;

export const connectionCreateRequestSchema = connectionBaseFields
	.extend({ idempotencyKey: z.string().min(8).max(128) })
	.check(checkAdapterFields as never);

export type ConnectionCreateRequest = z.infer<
	typeof connectionCreateRequestSchema
>;

/** Partial update; an omitted password keeps the stored one. */
export const connectionUpdateRequestSchema = z.object({
	id: z.string().min(1).max(255),
	name: z.string().min(1).max(255).optional(),
	host: z.string().min(1).max(255).optional(),
	port: z.number().int().min(1).max(65535).optional(),
	databaseName: z.string().min(1).max(255).optional(),
	username: z.string().min(1).max(255).optional(),
	password: z.string().max(1024).optional(),
	tlsMode: tlsModeSchema.optional(),
	readOnly: z.boolean().optional(),
	showAllSchemas: z.boolean().optional(),
	idempotencyKey: z.string().min(8).max(128),
});

export type ConnectionUpdateRequest = z.infer<
	typeof connectionUpdateRequestSchema
>;

export const connectionDeleteRequestSchema = z.object({
	id: z.string().min(1).max(255),
	idempotencyKey: z.string().min(8).max(128),
});

export type ConnectionDeleteRequest = z.infer<
	typeof connectionDeleteRequestSchema
>;

/**
 * Test a saved connection by id, or an unsaved dialog draft (fields only;
 * never persisted by the test action).
 */
export const connectionTestRequestSchema = z.union([
	z.object({ connectionId: z.string().min(1).max(255) }),
	z.object({ draft: connectionDraftSchema }),
]);

export type ConnectionTestRequest = z.infer<typeof connectionTestRequestSchema>;

export const workspaceDescriptorSchema = z.object({
	id: z.uuid(),
	name: z.string().min(1).max(255),
	role: workspaceRoleSchema,
	/** Workspace default target: managed UUID or "predefined:<slug>". */
	defaultConnectionRef: z.string().nullable(),
});

export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>;

/** Result payload of `workspace.open`. */
export const workspaceOpenResultSchema = z.object({
	workspace: workspaceDescriptorSchema,
	connections: z.array(connectionMetadataSchema),
	/** Capability descriptors for every registered adapter. */
	adapters: z.array(adapterInfoSchema),
	/** Shared workspace documents (metadata only; content via document.get). */
	documents: z.array(documentListEntrySchema),
});

export type WorkspaceOpenResult = z.infer<typeof workspaceOpenResultSchema>;

export const connectionTestResultSchema = z.object({
	ok: z.boolean(),
	latencyMs: z.number().nonnegative().optional(),
	serverVersion: z.string().optional(),
	error: z
		.object({
			code: z.string().optional(),
			message: z.string(),
		})
		.optional(),
});

export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;
