-- Bukti wajib saat "Uang diterima" withdraw TikTok (screenshot bank / Seller Center) + hasil bacanya
ALTER TABLE "FinanceTransaction" ADD COLUMN IF NOT EXISTS "receivedProofPath" TEXT, ADD COLUMN IF NOT EXISTS "receivedProofMime" TEXT, ADD COLUMN IF NOT EXISTS "receivedProofRead" JSONB;
