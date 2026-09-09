-- The settings a project owns about an imported datasource
-- (docs/spec/git-datasources.md "What the repo owns").
--
-- The repository defines what the datasource *is* — engine, host, port,
-- database, user — and those stay read-only in the form, because the way
-- to change them is to edit the committed file everybody shares.
--
-- `read only` and `show all schemas` are a different kind of thing. They
-- are how *this project* uses the datasource: one is a safety net over
-- your own session, the other is a tree preference. Somebody who imports
-- a repository to poke at production should be able to keep read-only on
-- without opening a pull request against a repository they may not own.
--
-- NULL means "whatever the repository says", which is the default and is
-- distinguishable from an explicit override of the same value.
ALTER TABLE git_datasources
	ADD COLUMN read_only_override boolean,
	ADD COLUMN show_all_schemas_override boolean;
