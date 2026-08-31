-- 0001_init.sql — initial DataGripe application schema (basic.md §8)

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (workspace_id, user_id)
);

-- Safe connection metadata only; secrets live in connection_secrets.
CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL,
  adapter text NOT NULL CHECK (adapter IN ('postgres')),
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  database_name text NOT NULL,
  username text NOT NULL,
  tls_mode text NOT NULL CHECK (tls_mode IN ('disable', 'require', 'verify-full')),
  read_only boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connection_secrets (
  connection_id uuid PRIMARY KEY REFERENCES connections (id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  key_version integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  title text NOT NULL,
  content text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 0,
  default_connection_id uuid REFERENCES connections (id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX documents_workspace_idx ON documents (workspace_id) WHERE archived_at IS NULL;

CREATE TABLE workspace_layouts (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  layout_json jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE query_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents (id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  query_hash text NOT NULL,
  preview text NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  row_count bigint,
  truncated boolean,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX query_executions_user_idx ON query_executions (user_id, created_at DESC);
CREATE INDEX query_executions_connection_idx ON query_executions (connection_id, created_at DESC);
