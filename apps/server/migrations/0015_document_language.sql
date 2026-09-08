-- Markdown as the second document language
-- (docs/spec/markdown-documents.md).
--
-- `docs/spec/datasource-paths.md` shipped naming this wart out loud: a
-- `.md` opened out of a datasource path got SQL highlighting, "and the
-- fix is a language field on the document rather than anything here".
--
-- Stored rather than derived on read, for two reasons: the client needs
-- the language before it has the content (the sidebar glyphs a runbook
-- differently from a query), and the editor should not discover a
-- language change from a keystroke. It is recomputed from the name on
-- save, alongside the title, and broadcast like any other change.
ALTER TABLE documents
	ADD COLUMN language text NOT NULL DEFAULT 'sql'
		CHECK (language IN ('sql', 'markdown'));

-- Existing rows are backfilled by the same rule the code applies: the
-- extension of the name decides. A file-backed document is named by its
-- path, everything else by its title.
UPDATE documents
SET language = 'markdown'
WHERE lower(coalesce(origin_file_path, title)) LIKE '%.md'
	OR lower(coalesce(origin_file_path, title)) LIKE '%.markdown';
