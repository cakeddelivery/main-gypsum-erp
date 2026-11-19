-- Tanggal mulai stok terpadu (cut-over) bawaan 1 Desember 2026; hanya bila belum ada. Owner bisa mengubah/mengundurkan di Stok > Cut-over.
INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES ('stok_terpadu_mulai', '2026-12-01', CURRENT_TIMESTAMP) ON CONFLICT ("key") DO NOTHING;
