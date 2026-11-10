-- Withdraw TikTok "Dalam Proses" (uang belum masuk bank) + konfirmasi saldo pagi
ALTER TYPE "TxStatus" ADD VALUE 'DALAM_PROSES' BEFORE 'DIBUKUKAN';

ALTER TABLE "FinanceTransaction" ADD COLUMN "sentAt" TIMESTAMP(3), ADD COLUMN "receivedAt" TIMESTAMP(3);

CREATE TYPE "BalanceCheckStatus" AS ENUM ('MENUNGGU', 'SESUAI', 'TIDAK_SESUAI');

CREATE TABLE "BalanceCheck" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "bookBalance" BIGINT NOT NULL,
    "currentBalance" BIGINT NOT NULL,
    "bankBalance" BIGINT,
    "diff" BIGINT,
    "status" "BalanceCheckStatus" NOT NULL DEFAULT 'MENUNGGU',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "done" BOOLEAN NOT NULL DEFAULT false,
    "checkedById" TEXT,
    "checkedByName" TEXT,
    "checkedAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BalanceCheck_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BalanceCheck_date_bankAccountId_key" ON "BalanceCheck"("date", "bankAccountId");
CREATE INDEX "BalanceCheck_status_idx" ON "BalanceCheck"("status");
ALTER TABLE "BalanceCheck" ADD CONSTRAINT "BalanceCheck_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Akun perantara "Dana dalam Perjalanan" (aset lancar, akun kas): WD TikTok yang sudah ditransfer tetapi belum masuk
-- bank. Kode otomatis = kode 1-125x..1-129x pertama yang masih kosong; kodenya disimpan di Setting coa_dana_perjalanan.
-- Aman dijalankan ulang.
DO $$
DECLARE c text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Setting" WHERE "key" = 'coa_dana_perjalanan') THEN
    SELECT "code" INTO c FROM "CoaAccount" WHERE "name" = 'Dana dalam Perjalanan' LIMIT 1;
    IF c IS NULL THEN
      SELECT '1-' || n::text INTO c FROM generate_series(1250, 1299) n
       WHERE NOT EXISTS (SELECT 1 FROM "CoaAccount" WHERE "code" = '1-' || n::text) ORDER BY n LIMIT 1;
      INSERT INTO "CoaAccount" ("id", "code", "name", "type", "isCash", "active")
      VALUES (gen_random_uuid()::text, c, 'Dana dalam Perjalanan', 'ASET', true, true);
    END IF;
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES ('coa_dana_perjalanan', c, CURRENT_TIMESTAMP);
  END IF;
END $$;
