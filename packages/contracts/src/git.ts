import { z } from "zod";
import { connectionAdapterSchema } from "./adapters";
import { tlsModeSchema } from "./connections";
import {
	domainColourSchema,
	domainNameSchema,
	domainTargetSchema,
} from "./domains";
import { datasourcePathNameSchema } from "./files";

/**
 * Git datasources (docs/spec/git-datasources.md).
 *
 * The repository is the definition: a `.datagripe/` directory at the
 * work tree root describes the connection, the directories worth
 * showing and the domain tagging, so a teammate who clones the repo
 * gets the same datasource without configuring anything.
 *
 * Three files rather than one, split by feature: a config that is
 * "really just connection info and branding" stays readable in a diff,
 * while a domain dump churns every time somebody tags a table.
 */

/** The directory, at the work tree root, that makes a repo a datasource. */
export const DATAGRIPE_DIR = ".datagripe";
export const CONFIG_FILE = "config.yaml";
export const SYNC_FILE = "sync.yaml";
export const DOMAINS_FILE = "domains.yaml";

/**
 * A path inside the repository. Always relative to the work tree root:
 * `foo`, `./foo` and `foo/` are one directory. Absolute is refused, and
 * so is anything that climbs out — a committed file that could name
 * `/etc` would be a remote read primitive with extra steps.
 */
export const repoRelativePathSchema = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(value) => !value.startsWith("/"),
		"must be relative to the repo root",
	)
	.refine(
		(value) => !/^[A-Za-z]:[\\/]/.test(value),
		"must be relative to the repo root",
	)
	.refine(
		(value) => !value.split(/[\\/]/).includes(".."),
		"must not climb out of the repo root",
	);

/* ---- config.yaml ----------------------------------------------------- */

/**
 * The connection, as the repository declares it. This is the predefined
 * connection shape minus `id` and `workspaces`, both of which are
 * meaningless here: the repository *is* the identity, and visibility is
 * whoever can see the checkout.
 *
 * There is no inline `password`. `connections.json` can get away with
 * "development only" because it is gitignored; this file is the
 * opposite of gitignored, so an inline secret is refused rather than
 * deprecated.
 */
export const repoDatasourceSchema = z.object({
	name: z.string().min(1).max(255),
	adapter: connectionAdapterSchema,
	host: z.string().min(1).max(255).optional(),
	port: z.number().int().min(1).max(65535).optional(),
	database: z.string().min(1).max(1024),
	username: z.string().max(255).optional(),
	/** Indirection into the server's environment. The only secret path. */
	passwordEnv: z.string().min(1).max(255).optional(),
	/**
	 * This database takes no password at all — a `trust`-auth cluster on
	 * loopback, which is what a self-contained example checkout runs.
	 *
	 * Explicit rather than inferred from a missing `passwordEnv`, because
	 * inferring it would turn a typo in a variable name into a silent
	 * attempt to connect with no credential.
	 */
	noPassword: z.boolean().default(false),
	tlsMode: tlsModeSchema.default("disable"),
	readOnly: z.boolean().default(true),
	showAllSchemas: z.boolean().default(false),
});

export type RepoDatasource = z.infer<typeof repoDatasourceSchema>;

/**
 * Optional presentation, so prod does not look like staging. The colour
 * is one of the eight palette slots domains already use.
 */
export const repoBrandingSchema = z.object({
	colour: domainColourSchema.optional(),
	description: z.string().max(500).optional(),
});

export type RepoBranding = z.infer<typeof repoBrandingSchema>;

export const repoPathSchema = z.object({
	name: datasourcePathNameSchema,
	path: repoRelativePathSchema,
});

export type RepoPath = z.infer<typeof repoPathSchema>;

/**
 * `.datagripe/config.yaml`.
 *
 * Unknown *top-level* keys are preserved on write and ignored on read,
 * so an older DataGripe does not silently delete a newer one's settings
 * when it rewrites the file. Unknown keys inside a block DataGripe owns
 * are an error, because that is almost always a typo.
 */
export const repoConfigSchema = z
	.looseObject({
		version: z.literal(1),
		datasource: repoDatasourceSchema,
		branding: repoBrandingSchema.optional(),
		paths: z.array(repoPathSchema).max(20).default([]),
	})
	.check((ctx) => {
		const source = ctx.value.datasource;
		// One of the two, never both and never neither: "which credential
		// does this use" must have exactly one answer in the file.
		if (source.noPassword && source.passwordEnv !== undefined) {
			ctx.issues.push({
				code: "custom",
				message:
					"noPassword and passwordEnv are alternatives — set one, not both",
				path: ["datasource", "noPassword"],
				input: source,
			});
		}
		if (!source.noPassword && source.passwordEnv === undefined) {
			ctx.issues.push({
				code: "custom",
				message:
					"set passwordEnv to name an environment variable, or noPassword: true if this database takes none",
				path: ["datasource", "passwordEnv"],
				input: source,
			});
		}
	});

export type RepoConfig = z.infer<typeof repoConfigSchema>;

/* ---- sync.yaml ------------------------------------------------------- */

export const repoSyncSchema = z.object({
	/** Where the domain export writes, relative to the work tree root. */
	dir: repoRelativePathSchema,
	includeAccessReports: z.boolean().default(true),
	maxDataRows: z.number().int().positive().max(1_000_000).optional(),
});

export type RepoSync = z.infer<typeof repoSyncSchema>;

export const repoSyncFileSchema = z.looseObject({
	version: z.literal(1),
	sync: repoSyncSchema,
});

export type RepoSyncFile = z.infer<typeof repoSyncFileSchema>;

/* ---- domains.yaml ---------------------------------------------------- */

/**
 * Replaces `manifest.json` (docs/spec/domains.md "The manifest") for
 * every datasource, not only git ones: one serialisation format for the
 * `.datagripe` directory is worth more than compatibility with a file
 * that has existed for one phase.
 *
 * Written by the export, read by the import. The `.sql` files are
 * output and are never read back.
 */
export const repoDomainsFileSchema = z.object({
	version: z.literal(1),
	connection: z.object({
		ref: z.string().min(1).max(255),
		name: z.string(),
		engine: z.string(),
	}),
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

export type RepoDomainsFile = z.infer<typeof repoDomainsFileSchema>;

/* ---- adding and removing --------------------------------------------- */

/**
 * Clone a URL into the repos home, or adopt a checkout already on disk.
 * One form, two shapes, both ending with `.datagripe/config.yaml` being
 * read out of a work tree root.
 */
export const gitDatasourceAddRequestSchema = z.union([
	z.object({
		mode: z.literal("clone"),
		/** Validated by the same SSRF policy as a connection host. */
		url: z.string().min(1).max(2048),
		/** Optional branch to check out; git's default otherwise. */
		branch: z.string().min(1).max(255).optional(),
		idempotencyKey: z.string().min(8).max(128),
	}),
	z.object({
		mode: z.literal("adopt"),
		/** Absolute path of the work tree root, not a directory inside it. */
		path: z.string().min(1).max(1024),
		idempotencyKey: z.string().min(8).max(128),
	}),
]);

export type GitDatasourceAddRequest = z.infer<
	typeof gitDatasourceAddRequestSchema
>;

export const gitDatasourceRemoveRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	/**
	 * Delete the checkout too. Honoured only for a clone DataGripe made;
	 * an adopted directory is never deleted whatever this says.
	 */
	deleteCheckout: z.boolean().default(false),
	idempotencyKey: z.string().min(8).max(128),
});

export type GitDatasourceRemoveRequest = z.infer<
	typeof gitDatasourceRemoveRequestSchema
>;

/** What the sidebar and the datasource page need to know about the repo. */
export const gitDatasourceSchema = z.object({
	/** `ConnectionMetadata.id` — always `git:<uuid>`. */
	connectionRef: z.string().min(1).max(255),
	/** Work tree root on the host the server runs on. */
	repoPath: z.string(),
	remoteUrl: z.string().nullable(),
	/** DataGripe made this checkout, so DataGripe may delete it. */
	managedClone: z.boolean(),
	/** The sync dir from sync.yaml, resolved absolute; null when unset. */
	syncPath: z.string().nullable(),
	/**
	 * A password stored here rather than named by the repository. The
	 * value never leaves the server; this only says whether there is one,
	 * so the form can offer to replace or clear it.
	 */
	hasStoredPassword: z.boolean(),
	/** What the repository asks for, so the form can show what an
	 * override is overriding. */
	repoReadOnly: z.boolean(),
	repoShowAllSchemas: z.boolean(),
	/** Null where this project has not overridden the repository. */
	readOnlyOverride: z.boolean().nullable(),
	showAllSchemasOverride: z.boolean().nullable(),
	/**
	 * Why this datasource cannot currently be connected to — an unset
	 * `passwordEnv`, most often. Listed and not connectable beats hidden:
	 * the person who cloned the repo should be told which variable to set.
	 */
	unavailable: z.string().nullable(),
});

export type GitDatasource = z.infer<typeof gitDatasourceSchema>;

export const gitDatasourceReloadRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
});

/**
 * The settings a project owns about an imported datasource.
 *
 * Everything describing *what the datasource is* comes from the
 * repository and is not here. These three are about how this project
 * uses it: a password the repository must never carry, a safety net over
 * your own session, and a tree preference.
 *
 * Every field is optional and only the ones present are written, so the
 * form can save a password without also asserting an opinion about
 * `read only`.
 */
export const gitDatasourceOptionsRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	/**
	 * Stored encrypted with the same keyring as every other connection
	 * secret, and never written to the repository. The empty string
	 * clears it, falling back to `passwordEnv` or to `noPassword`.
	 */
	password: z.string().max(1024).optional(),
	/** null resets to whatever `config.yaml` says. */
	readOnly: z.boolean().nullable().optional(),
	showAllSchemas: z.boolean().nullable().optional(),
	idempotencyKey: z.string().min(8).max(128),
});

export type GitDatasourceOptionsRequest = z.infer<
	typeof gitDatasourceOptionsRequestSchema
>;

export type GitDatasourceReloadRequest = z.infer<
	typeof gitDatasourceReloadRequestSchema
>;

/* ---- the repository section ------------------------------------------ */

/**
 * One `git status --porcelain -uall` row, as git wrote it. The status
 * letters are not paraphrased: people who use git read `??` and ` M`
 * already, and people who do not are not served by an invented word.
 */
export const gitStatusEntrySchema = z.object({
	/** The two porcelain columns: index status then work tree status. */
	status: z.string().length(2),
	/** Repo-relative path. For a rename, the destination. */
	path: z.string(),
	/** Where a rename came from. */
	originalPath: z.string().nullable(),
	/** Column one is not a space or `?`: this is already staged. */
	staged: z.boolean(),
});

export type GitStatusEntry = z.infer<typeof gitStatusEntrySchema>;

export const gitStatusRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
});

export type GitStatusRequest = z.infer<typeof gitStatusRequestSchema>;

/**
 * Past this many changed files the section shows a count and says to use
 * a terminal. A twelve-thousand-file status is not a list anybody is
 * going to tick through.
 */
export const GIT_STATUS_MAX_ENTRIES = 500;

export const gitStatusResultSchema = z.object({
	/**
	 * The work tree root, so a repo-relative row can be matched against
	 * the datasource's configured (absolute) paths and opened. Without it
	 * the client has two path vocabularies and no way to relate them.
	 */
	repoPath: z.string(),
	branch: z.string().nullable(),
	/** Tracking branch, when there is one. */
	upstream: z.string().nullable(),
	ahead: z.number().int().nonnegative(),
	behind: z.number().int().nonnegative(),
	entries: z.array(gitStatusEntrySchema),
	/** Total changed files; above the cap, more than `entries` holds. */
	total: z.number().int().nonnegative(),
	truncated: z.boolean(),
});

export type GitStatusResult = z.infer<typeof gitStatusResultSchema>;

/** Paths are pathspecs terminated with `--`; nothing is ever `-A`. */
export const gitStageRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	paths: z
		.array(z.string().min(1).max(1024))
		.min(1)
		.max(GIT_STATUS_MAX_ENTRIES),
	/** false runs `restore --staged`: unticking a row unstages it. */
	staged: z.boolean(),
});

export type GitStageRequest = z.infer<typeof gitStageRequestSchema>;

/**
 * Stage exactly the named paths, then commit. Never `add -A`, never a
 * pathspec the person did not tick — the guarantee from
 * docs/spec/domains.md "Committing", in the form the sidebar needs.
 */
export const gitCommitRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	message: z.string().min(1).max(4096),
	paths: z
		.array(z.string().min(1).max(1024))
		.max(GIT_STATUS_MAX_ENTRIES)
		.default([]),
	idempotencyKey: z.string().min(8).max(128),
});

export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>;

export const gitPushRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	/** First push of a new branch needs `-u`; still no user-supplied flags. */
	setUpstream: z.boolean().default(false),
	idempotencyKey: z.string().min(8).max(128),
});

export type GitPushRequest = z.infer<typeof gitPushRequestSchema>;

export const gitPullRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	idempotencyKey: z.string().min(8).max(128),
});

export type GitPullRequest = z.infer<typeof gitPullRequestSchema>;

/**
 * Git's verdict, not ours: stdout, stderr and the exit code, verbatim.
 * No interpretation and no "something went wrong".
 */
export const gitCommandResultSchema = z.object({
	exitCode: z.number().int(),
	stdout: z.string(),
	stderr: z.string(),
	/** Set by a commit that produced one. */
	commitSha: z.string().nullable(),
	/** The status after the operation, so the section never goes stale. */
	status: gitStatusResultSchema,
	/**
	 * A pull that moved HEAD. The client re-runs the disk check for every
	 * file-backed document it holds from this datasource, and reloads the
	 * connection list when a `.datagripe/` file changed.
	 */
	headMoved: z.boolean().default(false),
	/** Repo-relative paths the operation changed on disk. */
	changedPaths: z.array(z.string()).default([]),
});

export type GitCommandResult = z.infer<typeof gitCommandResultSchema>;

/* ---- exporting a config ---------------------------------------------- */

/**
 * Generate the `.datagripe/` file set from a datasource that already
 * exists, so it can be committed into a repository.
 *
 * `dryRun` renders without writing. That is the default the form uses:
 * half the time the destination is a repository on a different machine
 * and what is wanted is the text, not a write.
 */
export const exportConfigRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	/** Absolute directory to write `.datagripe/` into. */
	targetDir: z.string().min(1).max(1024),
	dryRun: z.boolean().default(true),
	/** Required to write over files that are already there. */
	overwrite: z.boolean().default(false),
	idempotencyKey: z.string().min(8).max(128),
});

export type ExportConfigRequest = z.infer<typeof exportConfigRequestSchema>;

export const exportConfigFileSchema = z.object({
	/** Relative to the target dir, e.g. `.datagripe/config.yaml`. */
	path: z.string(),
	content: z.string(),
	/** A file already at that path, which `overwrite` is needed for. */
	exists: z.boolean(),
});

export type ExportConfigFile = z.infer<typeof exportConfigFileSchema>;

export const exportConfigResultSchema = z.object({
	files: z.array(exportConfigFileSchema),
	written: z.boolean(),
	/**
	 * The environment variable the generated config names. Surfaced in
	 * the panel rather than left in the file, because a placeholder that
	 * looks like a setting is worse than a missing one.
	 */
	passwordEnv: z.string(),
	/**
	 * Configured paths that do not sit inside the target repository. They
	 * are written as commented absolute paths, never as broken relative
	 * ones — silently dropping them is how a teammate ends up with three
	 * of your four sections.
	 */
	outsideRepo: z.array(z.object({ name: z.string(), path: z.string() })),
});

export type ExportConfigResult = z.infer<typeof exportConfigResultSchema>;
