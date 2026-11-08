-- Index mutasi stok: cari mutasi per referensi (hapus produksi/borongan/pembelian) dan daftar mutasi terbaru
CREATE INDEX IF NOT EXISTS "StockMovement_ref_idx" ON "StockMovement"("ref");
CREATE INDEX IF NOT EXISTS "StockMovement_date_idx" ON "StockMovement"("date");
