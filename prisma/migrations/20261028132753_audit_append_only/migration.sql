-- Audit log append-only: tolak UPDATE / DELETE / TRUNCATE
CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog bersifat append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_mutation();

-- Jurnal yang sudah dibukukan tidak boleh diubah/dihapus (koreksi via jurnal pembalik)
CREATE OR REPLACE FUNCTION journal_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Jurnal yang sudah dibukukan tidak dapat diubah atau dihapus';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_no_update BEFORE UPDATE OR DELETE ON "Journal"
  FOR EACH ROW EXECUTE FUNCTION journal_block_mutation();
CREATE TRIGGER journal_line_no_update BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION journal_block_mutation();
