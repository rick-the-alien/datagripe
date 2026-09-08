-- The access report's role set (docs/spec/access-report.md "Which roles
-- are columns").
--
-- DataGripe cannot know which of forty roles matter, and it must not
-- guess which one is the PostgREST anonymous role: guessing wrong either
-- floods the report with findings or silences the one role that
-- mattered. So the marks are stored, and the UI only ever suggests.
CREATE TABLE datasource_roles (
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	connection_ref text NOT NULL,
	role_name text NOT NULL,
	-- The PostgREST anonymous role. What makes the grant.* rules fire.
	untrusted boolean NOT NULL DEFAULT false,
	-- Requests arrive as any role this one can SET ROLE to, so marking it
	-- expands the matrix columns transitively.
	authenticator boolean NOT NULL DEFAULT false,
	shown boolean NOT NULL DEFAULT true,
	PRIMARY KEY (workspace_id, connection_ref, role_name)
);
