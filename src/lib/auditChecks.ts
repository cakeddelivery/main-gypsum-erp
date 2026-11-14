import type { PrismaClient } from "@prisma/client";
import { COA } from "./accounting";

/**
 * Sumber yang seharusnya hanya punya SATU jurnal aktif per dokumen. Sumber lain memang wajar punya beberapa jurnal
 * per dokumen (PRODUKSI: konsumsi/reject/barang jadi, KASBON: kasbon & pelunasan, SISIHAN: satu per hari per dana,
 * PENJUALAN: nota & cicilan, BORONGAN, STOK).
 */
const SINGLE = ["FINANCE", "WITHDRAW_PENJUALAN", "PEMBELIAN", "PAYROLL", "SALDO_AWAL"];

export type DuplicateGroup = { kind: "SUMBER" | "PENJUALAN_WD"; source: string; sourceId: string; numbers: string[] };

/**
 * Jurnal ganda yang masih aktif. Jurnal yang sudah dibalik dan jurnal pembaliknya tidak dihitung, jadi koreksi lewat
 * jurnal balik (ganti toko, ubah kategori, batal & catat ulang) tidak muncul sebagai alarm palsu.
 *  - SUMBER: lebih dari satu jurnal aktif untuk dokumen yang sama pada sumber "satu jurnal".
 *  - PENJUALAN_WD: satu transaksi withdraw punya lebih dari satu jurnal aktif yang mencatat pemasukan penjualan
 *    (jurnal transaksinya sendiri dan/atau jurnal pemasukan susulan WITHDRAW_PENJUALAN).
 */
export async function activeDuplicateJournals(db: Pick<PrismaClient, "journal" | "coaAccount">, start: Date): Promise<DuplicateGroup[]> {
  const rows = await db.journal.findMany({
    where: { sourceId: { not: null }, reversalOfId: null, date: { gte: start }, source: { in: SINGLE } },
    select: { id: true, number: true, source: true, sourceId: true, description: true, lines: { select: { accountId: true, credit: true } } },
    orderBy: { number: "asc" },
  });
  const reversed = new Set(
    (await db.journal.findMany({ where: { reversalOfId: { in: rows.map((r) => r.id) } }, select: { reversalOfId: true } })).map((r) => r.reversalOfId!),
  );
  const active = rows.filter((r) => !reversed.has(r.id));
  const out: DuplicateGroup[] = [];
  const bySource = new Map<string, typeof active>();
  // Pesanan pembelian: jurnal DP pesanan dan jurnal "Sisa pesanan … tidak datang" (Tutup pesanan) memang dua jurnal
  const keyOf = (r: (typeof active)[number]) => `${r.source}|${r.sourceId}${r.source === "PEMBELIAN" && r.description.startsWith("Sisa pesanan") ? ":TUTUP" : ""}`;
  for (const r of active) bySource.set(keyOf(r), [...(bySource.get(keyOf(r)) ?? []), r]);
  for (const g of bySource.values()) if (g.length > 1) out.push({ kind: "SUMBER", source: g[0].source, sourceId: g[0].sourceId!, numbers: g.map((r) => r.number) });

  const sales = await db.coaAccount.findUnique({ where: { code: COA.PENJUALAN }, select: { id: true } });
  if (sales) {
    const income = new Map<string, typeof active>();
    for (const r of active) {
      if (r.source !== "FINANCE" && r.source !== "WITHDRAW_PENJUALAN") continue;
      if (!r.lines.some((l) => l.accountId === sales.id && Number(l.credit) > 0)) continue;
      income.set(r.sourceId!, [...(income.get(r.sourceId!) ?? []), r]);
    }
    for (const [sourceId, g] of income) if (g.length > 1) out.push({ kind: "PENJUALAN_WD", source: "PENJUALAN", sourceId, numbers: g.map((r) => r.number) });
  }
  return out;
}
