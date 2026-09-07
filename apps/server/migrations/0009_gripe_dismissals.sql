-- Gripe dismissals (docs/spec/gripes.md "Dismissal").
--
-- Team-wide rather than personal: a schema finding is a team fact, and a
-- dismissal that only silenced one member's panel would have every
-- member dismiss the same thing. Recorded as an open question in the
-- spec; `dismissed_by` is kept so the decision can be revisited without
-- losing who did it.
CREATE TABLE gripe_dismissals (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	rule_id text NOT NULL,
	scope text NOT NULL CHECK (scope IN ('occurrence', 'target', 'project')),
	-- occurrence: the finding's statement fingerprint.
	-- target: a document id, or `object:<schema>.<name>`.
	-- project: the empty string, so the unique index can cover every scope.
	key text NOT NULL DEFAULT '',
	dismissed_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	dismissed_at timestamptz NOT NULL DEFAULT now()
);

-- Dismissing the same thing twice is not an error, it is a no-op.
CREATE UNIQUE INDEX gripe_dismissals_unique
	ON gripe_dismissals (workspace_id, rule_id, scope, key);

CREATE INDEX gripe_dismissals_workspace ON gripe_dismissals (workspace_id);
