-- Git datasources: the repository is the definition
-- (docs/spec/git-datasources.md).
--
-- A pointer, not a copy. Nothing out of `.datagripe/config.yaml` is
-- denormalised here, because then there would be two answers to what
-- the datasource is and one of them would be stale. The file is read on
-- workspace.open and cached in memory against its mtime and size.
CREATE TABLE git_datasources (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	-- Absolute path of the work tree root on the host the server runs on.
	repo_path text NOT NULL,
	-- The remote it was cloned from; NULL when an existing checkout was
	-- adopted. Display only: the remote of record is whatever
	-- `git remote` says now.
	remote_url text,
	-- True only when DataGripe created this directory, and therefore the
	-- only case in which it may delete it. Removing an adopted datasource
	-- removes the row and touches nothing on disk.
	managed_clone boolean NOT NULL DEFAULT false,
	created_by uuid REFERENCES users (id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	-- One datasource per checkout per workspace. Adding the same repo
	-- twice is a mistake, not two datasources.
	UNIQUE (workspace_id, repo_path)
);

CREATE INDEX git_datasources_workspace_idx
	ON git_datasources (workspace_id);

-- A password for a git datasource, when the deployment would rather not
-- export an environment variable. The repository never carries one:
-- `config.yaml` is committed, so an inline `password:` is refused
-- outright rather than deprecated.
--
-- Encrypted with the same keyring as `connection_secrets`, and keyed to
-- the datasource row so removing the datasource takes the secret with
-- it.
CREATE TABLE git_datasource_secrets (
	datasource_id uuid PRIMARY KEY
		REFERENCES git_datasources (id) ON DELETE CASCADE,
	-- Same layout as connection_secrets: iv ‖ ciphertext ‖ tag in one
	-- blob, with the key version beside it so keys can rotate.
	ciphertext bytea NOT NULL,
	key_version integer NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);
