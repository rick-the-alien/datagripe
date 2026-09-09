import { z } from "zod";
import { objectKindSchema } from "./objects";

/**
 * Domain contracts (docs/spec/domains.md): a user-maintained label for
 * the dimension the catalog does not carry — which part of the product a
 * table or routine belongs to.
 *
 * Scoped to `(workspace, connectionRef)` rather than to either alone: a
 * production database and its analytics replica deserve their own lists,
 * and the same connection reached from two workspaces is two projects'
 * opinions about one database.
 */

/**
 * A palette slot, never a hex value — the theme owns the hue
 * (docs/spec/domains.md "The colour rail").
 */
export const domainColourSchema = z.number().int().min(1).max(8);

/**
 * Lowercase and hyphenated, because the name becomes a directory in the
 * export and a rename should be one directory rename in the diff.
 */
export const domainNameSchema = z
	.string()
	.min(1)
	.max(40)
	.regex(
		/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/,
		"lowercase letters, digits and hyphens; must start and end alphanumeric",
	);

/**
 * `ConnectionMetadata.id` — the same string every per-object action
 * passes as `connectionId`. A managed connection's UUID, or a predefined
 * connection's bare slug (`local-demo`).
 *
 * Deliberately *not* the `predefined:<slug>` form that
 * `workspaces.default_connection_ref` uses: domains are looked up in the
 * same breath as the objects they tag, so they follow the actions.
 */
export const connectionRefSchema = z.string().min(1).max(255);

export const domainSchema = z.object({
	id: z.string().uuid(),
	name: domainNameSchema,
	colour: domainColourSchema,
	description: z.string().max(500),
	/** Reference/config domains export INSERTs alongside their DDL. */
	includeData: z.boolean(),
	/**
	 * A shelf rather than a part of the project (docs/spec/domains.md
	 * "Hidden domains"). Its objects drop out of the schema tree unless
	 * `show hidden` is on, its group starts collapsed in the grouped
	 * tree, and the export skips it entirely — which is the point: an
	 * engine built-in or a function a plugin created is noise this
	 * project did not write and does not want to commit.
	 */
	hidden: z.boolean(),
	sortOrder: z.number().int(),
});

export type Domain = z.infer<typeof domainSchema>;

/**
 * One taggable object. `schema` and `name` are exactly as the explorer
 * tree shows them, so a PostgreSQL routine's name carries its identity
 * arguments and overloads tag independently.
 */
export const domainTargetSchema = z.object({
	schema: z.string().min(1).max(255),
	name: z.string().min(1).max(1024),
	kind: objectKindSchema,
});

export type DomainTarget = z.infer<typeof domainTargetSchema>;

export const domainTagSchema = z.object({
	domainId: z.string().uuid(),
	target: domainTargetSchema,
});

export type DomainTag = z.infer<typeof domainTagSchema>;

/** The key a tag is looked up by, and the id of a target in a Map. */
export function domainTargetKey(target: DomainTarget): string {
	return `${target.kind}:${target.schema}.${target.name}`;
}

export const domainListRequestSchema = z.object({
	connectionRef: connectionRefSchema,
});

export type DomainListRequest = z.infer<typeof domainListRequestSchema>;

export const domainListResultSchema = z.object({
	domains: z.array(domainSchema),
	tags: z.array(domainTagSchema),
});

export type DomainListResult = z.infer<typeof domainListResultSchema>;

export const domainUpsertRequestSchema = z.object({
	connectionRef: connectionRefSchema,
	/** Absent creates; present updates. */
	id: z.string().uuid().optional(),
	name: domainNameSchema,
	colour: domainColourSchema,
	description: z.string().max(500).default(""),
	includeData: z.boolean().default(false),
	hidden: z.boolean().default(false),
	sortOrder: z.number().int().min(0).max(9999).default(0),
	idempotencyKey: z.string().min(8).max(128),
});

export type DomainUpsertRequest = z.infer<typeof domainUpsertRequestSchema>;

export const domainDeleteRequestSchema = z.object({
	connectionRef: connectionRefSchema,
	id: z.string().uuid(),
});

export type DomainDeleteRequest = z.infer<typeof domainDeleteRequestSchema>;

/**
 * Batch assignment. `domainId: null` untags, which is the only way to
 * untag — there is no separate action, because "move to no domain" and
 * "move to another domain" are the same edit.
 */
export const domainTagRequestSchema = z.object({
	connectionRef: connectionRefSchema,
	targets: z.array(domainTargetSchema).min(1).max(2000),
	domainId: z.string().uuid().nullable(),
	idempotencyKey: z.string().min(8).max(128),
});

export type DomainTagRequest = z.infer<typeof domainTagRequestSchema>;

/* ---- export ---------------------------------------------------------- */

/**
 * One line of the export plan. `refused` is as important as `written`:
 * a silently omitted object is the failure mode of the scripts this
 * replaces (docs/spec/domains.md "The sync tab").
 */
export const exportPlanEntrySchema = z.object({
	/** Path relative to the domain root, always forward-slashed. */
	path: z.string(),
	action: z.enum(["written", "unchanged", "deleted", "refused"]),
	/** Present on `refused`: why, in one sentence. */
	reason: z.string().optional(),
});

export type ExportPlanEntry = z.infer<typeof exportPlanEntrySchema>;

export const exportPlanSchema = z.object({
	/** Absolute, resolved domain root the plan applies to. */
	root: z.string(),
	entries: z.array(exportPlanEntrySchema),
	domainCount: z.number().int(),
	objectCount: z.number().int(),
	untaggedCount: z.number().int(),
	written: z.number().int(),
	unchanged: z.number().int(),
	deleted: z.number().int(),
	refused: z.number().int(),
	/** True for a plan that touched nothing because `dryRun` was set. */
	dryRun: z.boolean(),
});

export type ExportPlan = z.infer<typeof exportPlanSchema>;

export const domainExportRequestSchema = z.object({
	connectionRef: connectionRefSchema,
	/** Build the plan and stop. The reviewed step before anything writes. */
	dryRun: z.boolean().default(true),
	idempotencyKey: z.string().min(8).max(128),
});

export type DomainExportRequest = z.infer<typeof domainExportRequestSchema>;

export const domainExportResultSchema = z.object({
	plan: exportPlanSchema,
	/** The `domain_exports` row id, absent for a dry run. */
	runId: z.string().uuid().nullable(),
});

export type DomainExportResult = z.infer<typeof domainExportResultSchema>;

export const domainRunSchema = z.object({
	id: z.string().uuid(),
	startedAt: z.string(),
	finishedAt: z.string().nullable(),
	actorEmail: z.string().nullable(),
	domainCount: z.number().int(),
	objectCount: z.number().int(),
	written: z.number().int(),
	deleted: z.number().int(),
	refused: z.number().int(),
	outcome: z.enum(["ok", "failed", "refused"]),
	error: z.string().nullable(),
	commitSha: z.string().nullable(),
});

export type DomainRun = z.infer<typeof domainRunSchema>;

export const domainRunsRequestSchema = z.object({
	connectionRef: connectionRefSchema,
	limit: z.number().int().min(1).max(100).default(20),
});

export type DomainRunsRequest = z.infer<typeof domainRunsRequestSchema>;

export const domainRunsResultSchema = z.object({
	runs: z.array(domainRunSchema),
	/** Absent when no export path is configured for the workspace. */
	root: z.string().nullable(),
	/** False when `DOMAIN_EXPORT_ROOTS` is empty — export is off. */
	exportEnabled: z.boolean(),
	/** False when `DOMAIN_EXPORT_GIT` is off — the buttons are absent. */
	gitEnabled: z.boolean(),
});

export type DomainRunsResult = z.infer<typeof domainRunsResultSchema>;

/* ---- git ------------------------------------------------------------- */

/**
 * The fixed verb list (docs/spec/domains.md "Committing"). There is no
 * pass-through of flags or arbitrary subcommands: an operation names an
 * intent, and the server owns the argv.
 */
export const domainGitOperationSchema = z.enum([
	"status",
	"commit",
	"commit-and-push",
]);

export type DomainGitOperation = z.infer<typeof domainGitOperationSchema>;

export const domainGitRequestSchema = z.object({
	connectionRef: connectionRefSchema,
	operation: domainGitOperationSchema,
	/** Required for the commit operations; one argv element, never a shell
	 * word, so a message of `--amend` is a message. */
	message: z.string().min(1).max(2000).optional(),
	runId: z.string().uuid().optional(),
});

export type DomainGitRequest = z.infer<typeof domainGitRequestSchema>;

export const domainGitResultSchema = z.object({
	operation: domainGitOperationSchema,
	/** Git's own verdict. Never interpreted, never softened. */
	exitCode: z.number().int(),
	stdout: z.string(),
	stderr: z.string(),
	branch: z.string().nullable(),
	/** Porcelain lines scoped to the domain root. */
	changed: z.array(z.string()),
	commitSha: z.string().nullable(),
});

export type DomainGitResult = z.infer<typeof domainGitResultSchema>;

/* ---- manifest -------------------------------------------------------- */

/**
 * `manifest.json` — the round-trip source of truth, and the only file
 * `domain.import` reads. It is committed to a repository, so it carries
 * no host, no port, no user and no credential.
 */
export const domainManifestSchema = z.object({
	version: z.literal(1),
	connection: z.object({
		ref: connectionRefSchema,
		name: z.string(),
		engine: z.string(),
	}),
	/**
	 * Visible domains only. A hidden domain carries no `hidden` field
	 * here because it never reaches this file at all — the export skips
	 * it, and an import leaves the local hidden ones alone rather than
	 * replacing them (docs/spec/domains.md "Hidden domains").
	 */
	domains: z.array(
		z.object({
			name: domainNameSchema,
			colour: domainColourSchema,
			description: z.string(),
			includeData: z.boolean(),
			objects: z.array(domainTargetSchema),
		}),
	),
});

export type DomainManifest = z.infer<typeof domainManifestSchema>;

export const domainImportRequestSchema = z.object({
	connectionRef: connectionRefSchema,
	/** Preview the diff without applying it. */
	dryRun: z.boolean().default(true),
	idempotencyKey: z.string().min(8).max(128),
});

export type DomainImportRequest = z.infer<typeof domainImportRequestSchema>;

export const domainImportResultSchema = z.object({
	domainsAdded: z.array(domainNameSchema),
	domainsRemoved: z.array(domainNameSchema),
	domainsChanged: z.array(domainNameSchema),
	tagsBefore: z.number().int(),
	tagsAfter: z.number().int(),
	dryRun: z.boolean(),
});

export type DomainImportResult = z.infer<typeof domainImportResultSchema>;

/**
 * Setting a datasource's export directory.
 *
 * A separate action from `connection.update` on purpose: that one
 * refuses predefined connections outright, and this field must be
 * settable on them. The path is not part of the datasource — it is what
 * this project does with it.
 */
export const domainExportPathRequestSchema = z.object({
	connectionRef: connectionRefSchema,
	/** Absolute; empty clears it. */
	path: z.string().max(1024),
	/**
	 * Resolve the path against `DOMAIN_EXPORT_ROOTS` and report, without
	 * saving. A *validation* step rather than a second save — a form with
	 * two save buttons makes someone press both to be safe
	 * (docs/brand/mocks/datasource-settings.html "The two save buttons").
	 */
	checkOnly: z.boolean().default(false),
	idempotencyKey: z.string().min(8).max(128),
});

export type DomainExportPathRequest = z.infer<
	typeof domainExportPathRequestSchema
>;

export const domainExportPathCheckSchema = z.object({
	ok: z.boolean(),
	/** The resolved absolute path when it is allowed. */
	resolved: z.string().nullable(),
	/** Why not, in one sentence, when it is not. */
	message: z.string(),
});

export type DomainExportPathCheck = z.infer<typeof domainExportPathCheckSchema>;
