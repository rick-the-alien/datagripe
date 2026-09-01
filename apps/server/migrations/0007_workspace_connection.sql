-- 0007_workspace_connection.sql — a workspace's default target connection.
-- References connections.id for managed connections or "predefined:<slug>"
-- for predefined ones (same ref pattern as query_executions).

ALTER TABLE workspaces ADD COLUMN default_connection_ref text;
