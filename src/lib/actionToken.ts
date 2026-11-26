import { Prisma } from "@prisma/client";
import { prisma } from "./db";

type Db = Prisma.TransactionClient | typeof prisma;

/** Kunci per nama/kode selama transaksi berjalan: dua permintaan paralel dengan kunci sama antre satu per satu */
export async function lockKey(tx: Db, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

export type TokenClaim = { fresh: true } | { fresh: false; state: string; message: string | null };

/** Klaim token kirim-form. fresh=true → boleh diproses; selain itu token sudah dipakai (state + pesan sukses sebelumnya) */
export async function claimToken(key: string, userId: string | null): Promise<TokenClaim> {
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO "ActionToken"("key","userId") VALUES (${key}, ${userId})
    ON CONFLICT ("key") DO NOTHING RETURNING "key"`;
  if (rows.length) {
    // Bersihkan token lama sesekali (tidak perlu disimpan lama)
    if (Math.random() < 0.02) await prisma.$executeRaw`DELETE FROM "ActionToken" WHERE "createdAt" < now() - interval '3 days'`.catch(() => 0);
    return { fresh: true };
  }
  const t = await prisma.actionToken.findUnique({ where: { key } });
  return { fresh: false, state: t?.state ?? "PROSES", message: t?.message ?? null };
}

export const finishToken = (key: string, message: string) => prisma.actionToken.updateMany({ where: { key }, data: { state: "SELESAI", message: message.slice(0, 500) } });
/** Gagal → token dilepas agar pengguna bisa mengirim ulang setelah memperbaiki isian */
export const releaseToken = (key: string) => prisma.actionToken.deleteMany({ where: { key } });
