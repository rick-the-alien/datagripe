-- 0002_idempotency.sql — idempotency records for mutating WS actions
-- (docs/initial_idea.md §10: retries after reconnect must not duplicate
-- document creation, connection creation, or executions).

CREATE TABLE idempotency_keys (
  key text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  action text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, action, key)
);
