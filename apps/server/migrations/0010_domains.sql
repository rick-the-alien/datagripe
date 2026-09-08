-- Domains (docs/spec/domains.md).
--
-- A domain is the label the catalog does not carry: which part of the
-- product a table or routine belongs to. Scoped to workspace ×
-- datasource, because a production database and its analytics replica
-- deserve their own lists, and the same connection reached from two
-- workspaces is two projects' opinions about one database.
CREATE TABLE domains (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	-- Managed connection UUID or `predefined:<slug>`; text because both
	-- shapes fit and a predefined slug has no row to reference.
	connection_ref text NOT NULL,
	-- Lowercase, [a-z0-9-]: the name becomes a directory in the export,
	-- so a rename should be one directory rename in the diff.
	name text NOT NULL CHECK (name ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
	-- Palette slot, not a hex value: the theme owns the hue.
	colour smallint NOT NULL CHECK (colour BETWEEN 1 AND 8),
	description text NOT NULL DEFAULT '',
	sort_order integer NOT NULL DEFAULT 0,
	-- Reference/config domains export INSERTs alongside their DDL.
	include_data boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX domains_unique_name
	ON domains (workspace_id, connection_ref, name);

CREATE INDEX domains_datasource
	ON domains (workspace_id, connection_ref, sort_order, name);

-- Tags are team-wide, like gripe dismissals: a domain is a fact about
-- the schema, not a personal bookmark. `tagged_by` is kept so the
-- decision can be revisited without losing who made it.
CREATE TABLE domain_tags (
	domain_id uuid NOT NULL REFERENCES domains (id) ON DELETE CASCADE,
	-- Namespace and name exactly as the explorer tree shows them, so a
	-- PostgreSQL routine name carries its identity arguments and
	-- overloads tag independently.
	schema text NOT NULL,
	name text NOT NULL,
	kind text NOT NULL CHECK (kind IN
		('table', 'view', 'function', 'procedure', 'sequence')),
	tagged_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	tagged_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (domain_id, schema, name, kind)
);

-- Finding an object's current tag means looking across every domain of
-- the datasource, so the lookup leads with the object, not the domain.
-- The primary key stops a double tag into the *same* domain; the
-- stronger "at most one domain per object" rule cannot be a constraint
-- here at all, because the datasource identity lives on `domains`. The
-- service enforces it in one transaction.
CREATE INDEX domain_tags_object ON domain_tags (schema, name, kind);

-- Export run history (docs/spec/domains.md "Run history"). Not keyed to
-- `domains`: a run covers the datasource, and it must survive every
-- domain in it being deleted.
CREATE TABLE domain_exports (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	connection_ref text NOT NULL,
	started_at timestamptz NOT NULL DEFAULT now(),
	finished_at timestamptz,
	actor uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	domain_count integer NOT NULL DEFAULT 0,
	object_count integer NOT NULL DEFAULT 0,
	written integer NOT NULL DEFAULT 0,
	deleted integer NOT NULL DEFAULT 0,
	refused integer NOT NULL DEFAULT 0,
	outcome text NOT NULL CHECK (outcome IN ('ok', 'failed', 'refused')),
	error text,
	-- Set when the run was committed from the sync tab.
	commit_sha text
);

CREATE INDEX domain_exports_recent
	ON domain_exports (workspace_id, connection_ref, started_at DESC);

-- Where the dump is written, per workspace. Validated against
-- DOMAIN_EXPORT_ROOTS on every export, never once at configuration
-- time, so a symlink swapped in afterwards is caught.
ALTER TABLE workspaces
	ADD COLUMN domain_export_path text;
