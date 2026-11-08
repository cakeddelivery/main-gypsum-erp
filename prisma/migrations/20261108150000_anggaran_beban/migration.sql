-- Anggaran beban bulanan per akun COA
CREATE TABLE "ExpenseBudget" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseBudget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExpenseBudget_year_month_accountId_key" ON "ExpenseBudget"("year", "month", "accountId");
CREATE INDEX "ExpenseBudget_year_month_idx" ON "ExpenseBudget"("year", "month");

ALTER TABLE "ExpenseBudget" ADD CONSTRAINT "ExpenseBudget_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CoaAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
