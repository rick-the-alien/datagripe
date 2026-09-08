import { z } from "zod";
import { connectionRefSchema } from "./domains";
import { objectKindSchema } from "./objects";

/**
 * Access report contracts (docs/spec/access-report.md).
 *
 * The report answers what a role can *actually* do, which is not what
 * `information_schema.role_table_grants` reports. That view lists direct
 * grants only: a `GRANT … TO PUBLIC` appears once as grantee `PUBLIC`
 * and a grant inherited through a role appears against the parent's
 * name, so scanning either for `anon` finds nothing while `anon` has the
 * privilege. Effective answers come from `has_*_privilege`; the ACL
 * parse exists only to explain them.
 */

export const privilegeSchema = z.enum([
	"select",
	"insert",
	"update",
	"delete",
	"execute",
	"usage",
]);

export type Privilege = z.infer<typeof privilegeSchema>;

/**
 * Why a role has a privilege. Anything other than `direct` is the
 * interesting part of the report — it is access nobody granted to that
 * role by name.
 */
export const accessSourceSchema = z.enum([
	"direct",
	"public",
	"role",
	"owner",
	"superuser",
]);

export type AccessSource = z.infer<typeof accessSourceSchema>;

export const accessCellSchema = z.object({
	role: z.string(),
	/** Effective privileges, from `has_*_privilege`. */
	privileges: z.array(privilegeSchema),
	sources: z.array(accessSourceSchema),
	/**
	 * The path, for rendering beside the `°` marker: `via PUBLIC`,
	 * `via member of authenticated`, `owner`. Null when every privilege
	 * is directly granted, which needs no explanation.
	 */
	path: z.string().nullable(),
	/**
	 * True when the role cannot enter the object's schema, so the
	 * privileges above are inert. A report that claims access a role does
	 * not have is worse than no report.
	 */
	schemaBlocked: z.boolean(),
});

export type AccessCell = z.infer<typeof accessCellSchema>;

export const rlsStateSchema = z.enum(["none", "off", "on", "forced"]);

export type RlsState = z.infer<typeof rlsStateSchema>;

export const accessObjectSchema = z.object({
	schema: z.string(),
	name: z.string(),
	kind: objectKindSchema,
	owner: z.string(),
	cells: z.array(accessCellSchema),
	/** `none` for objects RLS does not apply to. */
	rls: rlsStateSchema,
	policyCount: z.number().int(),
	/**
	 * Views only. A view without `security_invoker=true` reads its base
	 * relations as its owner, including the owner's RLS exemptions.
	 */
	securityInvoker: z.boolean().nullable(),
	/** Routines only. */
	securityDefiner: z.boolean().nullable(),
	/** Routines only: whether `proconfig` pins a `search_path`. */
	searchPathPinned: z.boolean().nullable(),
	/** True when column-level ACLs exist, which an object cell rounds off. */
	hasColumnGrants: z.boolean(),
	/** Domain name when the object is tagged, for grouping. */
	domain: z.string().nullable(),
});

export type AccessObject = z.infer<typeof accessObjectSchema>;

export const schemaUsageSchema = z.object({
	schema: z.string(),
	/** Role names with `USAGE`; every other selected role has none. */
	roles: z.array(z.string()),
});

export type SchemaUsage = z.infer<typeof schemaUsageSchema>;

/**
 * An `ALTER DEFAULT PRIVILEGES` entry — what the *next* object gets,
 * which is the difference between an audit you do once and one you do
 * forever.
 */
export const defaultAclEntrySchema = z.object({
	/** Role whose creations are affected. */
	owner: z.string(),
	schema: z.string().nullable(),
	objectType: z.string(),
	grantee: z.string(),
	privileges: z.array(privilegeSchema),
});

export type DefaultAclEntry = z.infer<typeof defaultAclEntrySchema>;

export const rlsPolicySchema = z.object({
	schema: z.string(),
	table: z.string(),
	name: z.string(),
	roles: z.array(z.string()),
	command: z.string(),
	using: z.string().nullable(),
	withCheck: z.string().nullable(),
});

export type RlsPolicy = z.infer<typeof rlsPolicySchema>;

/** Column-level grants for one relation, expanded on demand. */
export const columnGrantSchema = z.object({
	column: z.string(),
	role: z.string(),
	privileges: z.array(privilegeSchema),
});

export type ColumnGrant = z.infer<typeof columnGrantSchema>;

/**
 * A role as the picker shows it. All five flags change how a cell should
 * be read, so none of them is hidden.
 */
export const datasourceRoleSchema = z.object({
	name: z.string(),
	canLogin: z.boolean(),
	superuser: z.boolean(),
	bypassRls: z.boolean(),
	inherit: z.boolean(),
	memberOf: z.array(z.string()),
	/** The PostgREST anonymous role. Suggested by name, never assumed. */
	untrusted: z.boolean(),
	/** Requests arrive as any role this one can `SET ROLE` to. */
	authenticator: z.boolean(),
	/** Whether it is a column in the matrix. */
	shown: z.boolean(),
	/** True when the name matches `anon`/`web_anon`/... and nothing is
	 * marked yet — a suggestion the user confirms. */
	suggestedUntrusted: z.boolean(),
});

export type DatasourceRole = z.infer<typeof datasourceRoleSchema>;

export const accessRolesRequestSchema = z.object({
	connectionId: connectionRefSchema,
});

export type AccessRolesRequest = z.infer<typeof accessRolesRequestSchema>;

export const accessRolesResultSchema = z.object({
	roles: z.array(datasourceRoleSchema),
	/** Roles the authenticator can become, transitively. Empty when none
	 * is marked. */
	authenticatorReach: z.array(z.string()),
});

export type AccessRolesResult = z.infer<typeof accessRolesResultSchema>;

export const accessRoleSetRequestSchema = z.object({
	connectionId: connectionRefSchema,
	roles: z
		.array(
			z.object({
				name: z.string().min(1).max(255),
				untrusted: z.boolean(),
				authenticator: z.boolean(),
				shown: z.boolean(),
			}),
		)
		.max(200),
	idempotencyKey: z.string().min(8).max(128),
});

export type AccessRoleSetRequest = z.infer<typeof accessRoleSetRequestSchema>;

/** Cell-count ceiling; above it the request asks for a filter instead of
 * sitting there. */
export const ACCESS_REPORT_MAX_CELLS = 250_000;

export const accessReportRequestSchema = z.object({
	connectionId: connectionRefSchema,
	/** Empty means every visible schema. */
	schemas: z.array(z.string().min(1).max(255)).max(50).default([]),
	/** Narrow to one domain's objects (docs/spec/domains.md). */
	domainId: z.string().uuid().optional(),
	/** Count the cells and stop, so the tab can warn before a big run. */
	countOnly: z.boolean().default(false),
});

export type AccessReportRequest = z.infer<typeof accessReportRequestSchema>;

export const accessReportResultSchema = z.object({
	/** Column order, as selected. */
	roles: z.array(z.string()),
	objects: z.array(accessObjectSchema),
	schemaUsage: z.array(schemaUsageSchema),
	defaultAcl: z.array(defaultAclEntrySchema),
	policies: z.array(rlsPolicySchema),
	columnGrants: z.array(
		z.object({
			schema: z.string(),
			name: z.string(),
			grants: z.array(columnGrantSchema),
		}),
	),
	cellCount: z.number().int(),
	/** True when `countOnly` was set: everything above is empty. */
	countOnly: z.boolean(),
});

export type AccessReportResult = z.infer<typeof accessReportResultSchema>;

/** Names that suggest a PostgREST anonymous role. Suggestions only. */
export const UNTRUSTED_ROLE_HINTS = [
	"anon",
	"web_anon",
	"anonymous",
	"unauthenticated",
];

export function suggestsUntrusted(role: string): boolean {
	return UNTRUSTED_ROLE_HINTS.includes(role.toLowerCase());
}
