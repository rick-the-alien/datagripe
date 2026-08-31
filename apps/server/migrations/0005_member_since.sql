-- 0005_member_since.sql — membership timestamps for the members UI

ALTER TABLE workspace_members ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
