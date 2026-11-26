import type { Prisma } from "@prisma/client";
import { AccountingError, type LineInput } from "./accounting";

type Tx = Prisma.TransactionClient;

/** Jendela deteksi klik ganda / kirim ulang: dokumen identik oleh orang yang sama dalam rentang ini dianggap dobel */
export const DUP_WINDOW_MS = 2 * 60_000;

/** Serialkan permintaan yang berkunci sama dalam transaksi ini (permintaan paralel menunggu yang pertama selesai) */
export async function lockKey(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/**
 * Tolak jurnal manual yang identik (sumber, tanggal, keterangan, pembuat, jumlah baris & total) dengan yang baru
 * dibukukan beberapa menit lalu: kebiasaan klik dua kali / kirim ulang formulir tidak boleh membukukan dua kali.
 * Harus dipanggil di dalam transaksi yang sama dengan postJournal.
 */
export async function assertNotRecentDuplicateJournal(tx: Tx, p: { source: string; description: string; date: Date; createdBy: string; lines: LineInput[] }, now: Date = new Date()) {
  await lockKey(tx, `jurnal-ganda:${p.source}|${p.createdBy}|${p.date.toISOString()}|${p.description}`);
  const total = p.lines.reduce((a, l) => a + (l.debit ?? 0), 0);
  const recent = await tx.journal.findMany({
    where: { source: p.source, createdBy: p.createdBy, date: p.date, description: p.description, reversalOfId: null, createdAt: { gte: new Date(now.getTime() - DUP_WINDOW_MS) } },
    include: { lines: { select: { debit: true } } },
  });
  const hit = recent.find((j) => j.lines.length === p.lines.length && j.lines.reduce((a, l) => a + Number(l.debit), 0) === total);
  if (hit) throw new AccountingError(`Jurnal yang sama persis baru saja dibukukan (${hit.number}). Jika memang sengaja, ubah keterangan atau tunggu beberapa menit.`);
}
