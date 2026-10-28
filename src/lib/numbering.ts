import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { jakartaParts } from "./time";

type Tx = Prisma.TransactionClient | typeof prisma;

/** Nomor dokumen berurutan per prefix per bulan, aman untuk konkurensi (INSERT ... ON CONFLICT). */
export async function nextNumber(tx: Tx, prefix: string, at: Date = new Date()): Promise<string> {
  const p = jakartaParts(at);
  const period = `${p.year}${String(p.month).padStart(2, "0")}`;
  const key = `${prefix}-${period}`;
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "Counter"("key","value") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = "Counter"."value" + 1
    RETURNING "value"`;
  return `${key}-${String(rows[0].value).padStart(4, "0")}`;
}
