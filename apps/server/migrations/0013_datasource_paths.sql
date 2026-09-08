-- Datasource paths: project directories the sidebar browses
-- (docs/spec/datasource-paths.md).
--
-- A datasource almost always has a checkout somewhere — the migrations
-- that built it, the queries the team keeps, the dump the sync tab
-- writes. Each (name, path) pair becomes its own sidebar section above
-- the workspace files while that datasource is the active one.
--
-- A table rather than a jsonb column on `connections`, for the same
-- reason `datasource_export_paths` is one (migration 0012): a predefined
-- connection has no row there, and it must be able to carry paths too.
CREATE TABLE datasource_paths (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	-- `ConnectionMetadata.id`: a managed UUID, or a predefined slug. Text
	-- rather than a foreign key for the same reason as `domains`.
	connection_ref text NOT NULL,
	-- Section title in the sidebar.
	name text NOT NULL,
	path text NOT NULL,
	-- The order the sections appear in; the form owns it.
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX datasource_paths_datasource_idx
	ON datasource_paths (workspace_id, connection_ref, position);

-- A file opened out of a path is a normal workspace document that also
-- knows which file on disk it is. Cached here rather than re-read per
-- viewer so it gets the live multiplayer state every other shared file
-- has — presence, followed cursors, revision-guarded saves — with the
-- file on disk still the artifact: every save writes it back.
ALTER TABLE documents
	ADD COLUMN origin_connection_ref text,
	-- Not a foreign key to datasource_paths on purpose. Removing a path
	-- pair must not take a member's unsaved work with it, and CASCADE
	-- would: `datasource.set-paths` archives the affected documents
	-- instead, which is recoverable.
	ADD COLUMN origin_path_id uuid,
	ADD COLUMN origin_file_path text,
	-- sha256 of the bytes DataGripe last read from / wrote to the file.
	-- Lets `file.open` tell "changed underneath us" from "we changed it",
	-- which is the difference between adopting disk silently and asking.
	ADD COLUMN disk_content_hash text,
	ADD COLUMN disk_synced_at timestamptz,
	ADD CONSTRAINT documents_origin_complete CHECK (
		(origin_connection_ref IS NULL AND origin_path_id IS NULL
			AND origin_file_path IS NULL)
		OR (origin_connection_ref IS NOT NULL AND origin_path_id IS NOT NULL
			AND origin_file_path IS NOT NULL)
	);

-- One live document per file: opening the same file twice has to land on
-- the same row, or two people edit two caches of one file and the last
-- save wins silently.
CREATE UNIQUE INDEX documents_origin_idx
	ON documents (workspace_id, origin_path_id, origin_file_path)
	WHERE origin_path_id IS NOT NULL AND archived_at IS NULL;
