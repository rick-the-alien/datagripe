-- Move the export directory from the workspace to the datasource
-- (docs/spec/domains.md "Where it may write").
--
-- An export never crosses a datasource boundary: domains are scoped to
-- one, and a run writes exactly one `domains/` tree. A single path per
-- workspace meant two datasources in one project would overwrite each
-- other's export — silently, because both trees are structurally valid.
--
-- A table rather than a column on `connections`, because a predefined
-- connection has no row there and the demo project is exactly that case.
-- The path is workspace-local configuration about a datasource, not part
-- of the datasource definition, which is also why a predefined
-- connection can carry one while the rest of it stays read-only.
CREATE TABLE datasource_export_paths (
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	-- `ConnectionMetadata.id`: a managed UUID, or a predefined slug. Text
	-- rather than a foreign key for the same reason as `domains`.
	connection_ref text NOT NULL,
	path text NOT NULL,
	PRIMARY KEY (workspace_id, connection_ref)
);

-- Nothing is carried over: the old column could not say which datasource
-- it meant, and inventing an answer would point an export at the wrong
-- tree. Anyone who set one re-picks it on the datasource page.
ALTER TABLE workspaces DROP COLUMN domain_export_path;
