import type {
	ConnectionMetadata,
	GitDatasource,
	GitDatasourceAddRequest,
	RepoConfig,
	RepoSyncFile,
} from "@datagripe/contracts";
import type { ResolvedConnection } from "@datagripe/database-adapters";

/**
 * The seam between git datasources and the connections service
 * (docs/spec/git-datasources.md).
 *
 * A separate module with no imports from `connections/service` so the
 * connections service can depend on this interface without the two
 * files depending on each other. `git/service.ts` is free to use
 * `ServiceError` from over there; nothing here is.
 */

export interface GitDatasourceEntry {
	/** `git:<uuid>`, which is also `ConnectionMetadata.id`. */
	ref: string;
	repoPath: string;
	remoteUrl: string | null;
	managedClone: boolean;
	config: RepoConfig;
	sync: RepoSyncFile | null;
	/** Absolute sync directory, when `sync.yaml` names one. */
	syncPath: string | null;
	/**
	 * Why the datasource cannot currently be connected to — an unset
	 * `passwordEnv`, most often — or null when it can. Listed and not
	 * connectable beats hidden.
	 */
	unavailable: string | null;
	createdAt: string;
}

/**
 * The service plus the verbs only the dispatcher uses. Split from
 * `GitDatasourcesService` so the connections service depends on the
 * read half and cannot reach `add` or `remove`.
 */
export interface GitDatasourcesServiceWithAdmin extends GitDatasourcesService {
	add: (
		workspace: { id: string; name: string },
		userId: string,
		request: GitDatasourceAddRequest,
	) => Promise<ConnectionMetadata>;
	remove: (
		workspaceId: string,
		ref: string,
		deleteCheckout: boolean,
	) => Promise<void>;
	requireEntry: (
		workspaceId: string,
		ref: string,
	) => Promise<GitDatasourceEntry>;
}

export interface GitDatasourcesService {
	/**
	 * Every git datasource in the workspace, as connection metadata.
	 * Repositories whose config will not parse are reported with the
	 * problem in `unavailable` rather than dropped: a datasource that
	 * vanishes when somebody commits a typo is a bad way to find out.
	 */
	listMetadata: (workspace: {
		id: string;
		name: string;
	}) => Promise<ConnectionMetadata[]>;
	/** The entry behind a ref, or null when the ref is not a git one. */
	entryFor: (
		workspaceId: string,
		ref: string,
	) => Promise<GitDatasourceEntry | null>;
	/** Connect-time details, secret included. Never crosses the wire. */
	resolve: (
		workspaceId: string,
		ref: string,
	) => Promise<ResolvedConnection | null>;
	/** The shape the sidebar and the datasource page need. */
	describe: (workspaceId: string, ref: string) => Promise<GitDatasource | null>;
	/** Drop the cached config so the next read comes off disk. */
	invalidate: (repoPath?: string) => void;
}
