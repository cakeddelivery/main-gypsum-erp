-- Versi sesi: naik saat password diganti/direset, sesi lama otomatis tidak berlaku
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- Catatan percobaan login untuk batas per IP
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LoginAttempt_ip_createdAt_idx" ON "LoginAttempt"("ip", "createdAt");
CREATE INDEX "LoginAttempt_username_ip_createdAt_idx" ON "LoginAttempt"("username", "ip", "createdAt");
CREATE INDEX "LoginAttempt_createdAt_idx" ON "LoginAttempt"("createdAt");
