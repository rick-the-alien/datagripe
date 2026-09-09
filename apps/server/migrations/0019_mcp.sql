-- MCP: the project speaks to an agent (docs/spec/mcp.md).
--
-- Two rows and a column. The settings row is the opt-in — absent means
-- off, which is why there is no bootstrap insert anywhere: a project
-- that nobody has configured is a project with nothing listening.
CREATE TABLE mcp_settings (
	workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
	enabled boolean NOT NULL DEFAULT false,
	-- Read-only is a ceiling and not a grant: a datasource whose own
	-- `read only` setting is on stays read-only over MCP whatever this
	-- says. The mode decides whether DataGripe adds a restriction, not
	-- what the connection is allowed to do underneath.
	mode text NOT NULL DEFAULT 'read-only'
		CHECK (mode IN ('read-only', 'read-write')),
	updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- A bearer token, hashed at rest exactly like a session.
--
-- `user_id` is not decoration: the token delegates one person's access,
-- so their *current* membership role is resolved on every call and
-- capped by the mode. Removing them from the project stops their agent
-- too, which is the property that makes a long-lived token acceptable.
CREATE TABLE mcp_tokens (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	-- Which client this is, so revoking the right one does not need a
	-- guess: "claude code on the laptop", not a uuid prefix.
	name text NOT NULL,
	token_hash text NOT NULL UNIQUE,
	created_at timestamptz NOT NULL DEFAULT now(),
	-- No expiry column on purpose: a token that dies mid-task is worse
	-- than one that lives until somebody revokes it. Revocation is the
	-- control, and `last_used_at` is how you know whether to.
	last_used_at timestamptz,
	revoked_at timestamptz
);

CREATE INDEX mcp_tokens_workspace_idx
	ON mcp_tokens (workspace_id, created_at DESC);

-- Where an execution came from, so a teammate watching the results
-- panel is not left wondering who the third person in the project is.
-- `mcp_token_id` names the client rather than only the person, and
-- survives revocation (SET NULL would erase the answer for old rows,
-- so the label falls back to 'mcp' when the token is gone).
ALTER TABLE query_executions
	ADD COLUMN source text NOT NULL DEFAULT 'editor'
		CHECK (source IN ('editor', 'mcp')),
	ADD COLUMN mcp_token_id uuid REFERENCES mcp_tokens (id) ON DELETE SET NULL;
