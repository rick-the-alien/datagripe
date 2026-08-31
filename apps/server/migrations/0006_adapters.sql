-- 0006_adapters.sql — MySQL, SQLite, Redis connections (Phase 5)
-- adapter CHECK widened; sqlite (file-based) needs nullable host/port/
-- username/tls_mode.

ALTER TABLE connections DROP CONSTRAINT connections_adapter_check;
ALTER TABLE connections ADD CONSTRAINT connections_adapter_check
  CHECK (adapter IN ('postgres', 'mysql', 'sqlite', 'redis'));

ALTER TABLE connections ALTER COLUMN host DROP NOT NULL;
ALTER TABLE connections ALTER COLUMN port DROP NOT NULL;
ALTER TABLE connections ALTER COLUMN username DROP NOT NULL;
ALTER TABLE connections ALTER COLUMN tls_mode DROP NOT NULL;
