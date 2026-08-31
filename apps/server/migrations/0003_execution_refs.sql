-- 0003_execution_refs.sql — query history for Phase 3
-- connection_ref holds predefined connection ids (no FK possible);
-- connection_id becomes nullable for that case. document_id drops its FK:
-- Phase 1–3 documents are client-local (IndexedDB); the FK returns when
-- server-side document sync lands.

ALTER TABLE query_executions ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE query_executions ADD COLUMN connection_ref text;
ALTER TABLE query_executions DROP CONSTRAINT query_executions_document_id_fkey;
