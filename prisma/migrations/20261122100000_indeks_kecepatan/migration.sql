-- Indeks tambahan untuk mempercepat daftar & peringatan (aditif, tidak mengubah data)
CREATE INDEX IF NOT EXISTS "FinanceTransaction_date_idx" ON "FinanceTransaction"("date");
CREATE INDEX IF NOT EXISTS "Attendance_validated_date_idx" ON "Attendance"("validated", "date");
CREATE INDEX IF NOT EXISTS "Purchase_delivery_idx" ON "Purchase"("delivery");
CREATE INDEX IF NOT EXISTS "Purchase_date_idx" ON "Purchase"("date");
CREATE INDEX IF NOT EXISTS "Payable_dueDate_idx" ON "Payable"("dueDate");
