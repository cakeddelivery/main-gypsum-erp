import type { Prisma } from "@prisma/client";

/** Kunci transaksi per kunci teks: dua permintaan bersamaan untuk kunci yang sama diantre (dilepas saat transaksi selesai). */
export async function lockKey(tx: Prisma.TransactionClient, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}
