-- PostgreSQL runtime parameters per datasource.
--
-- `search_path` is the one that earns this: a datasource pointed at a
-- team's schema should resolve unqualified names there, instead of every
-- query having to say so. `application_name` comes free with the same
-- mechanism and is what a DBA reading pg_stat_activity wants.
--
-- The set is validated against an allowlist in
-- `packages/contracts/src/connectionParams.ts`, and that is not caution
-- for its own sake: these ride in the startup packet, where an
-- unrecognised parameter is a connect-time FATAL rather than a warning. A
-- free-form store would let one typo produce a datasource that cannot
-- connect at all, reporting a parameter name instead of the field it came
-- from. The CHECK here is a backstop for the same thing, not the rule.
--
-- A child of `connections` rather than a (workspace_id, connection_ref)
-- table like datasource_paths (0013) or datasource_export_paths (0012).
-- Those hold workspace-local configuration *about* a datasource, which is
-- why they carry no foreign key and work for predefined and git sources
-- too. These are part of the definition — `search_path` changes what a
-- query means — so a predefined datasource carries them in
-- connections.json and a git one in config.yaml, and ref-keyed rows for
-- either would be rows nobody reads.
--
-- No position column: a record has no order, and the primary key gives
-- deduplication for free.
CREATE TABLE connection_params (
	connection_id uuid NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
	name text NOT NULL CHECK (name IN ('search_path', 'application_name')),
	value text NOT NULL CHECK (length(value) BETWEEN 1 AND 255),
	PRIMARY KEY (connection_id, name)
);
