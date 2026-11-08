-- Dana talangan: transaksi pengembalian talangan dari rekening operasional ke dompet simpanan dana sisihan
ALTER TABLE "FinanceTransaction" ADD COLUMN "bailoutRepay" BOOLEAN NOT NULL DEFAULT false;
