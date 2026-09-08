-- Approval for the commands a repository declares
-- (docs/spec/repo-commands.md).
--
-- `.datagripe/run.yaml` is the one thing in that directory DataGripe
-- executes rather than interprets, and it arrives over the network on
-- `git pull`. Without a record of what somebody agreed to run, a pull is
-- remote code execution with a friendly button.
--
-- What is stored is a hash of the *semantic* command list — names, argv,
-- cwd, env, timeouts — so reformatting the YAML does not invalidate an
-- approval and changing a single argument does.
CREATE TABLE git_datasource_trust (
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	datasource_id uuid NOT NULL
		REFERENCES git_datasources (id) ON DELETE CASCADE,
	commands_hash text NOT NULL,
	-- Per workspace rather than per person: a project is a set of people
	-- who already share a database and a checkout, and making each of
	-- them approve the same list separately trains everybody to click
	-- through it. One person vouches; this records which one.
	approved_by uuid REFERENCES users (id) ON DELETE SET NULL,
	approved_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (workspace_id, datasource_id)
);
