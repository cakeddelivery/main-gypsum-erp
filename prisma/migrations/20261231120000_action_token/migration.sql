-- Token kirim-form (cegah simpan ganda karena klik ganda / kirim ulang / retry). Hanya ADD.
CREATE TABLE "ActionToken" (
    "key" TEXT NOT NULL,
    "userId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PROSES',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActionToken_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "ActionToken_createdAt_idx" ON "ActionToken"("createdAt");
