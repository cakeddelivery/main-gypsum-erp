import type { Prisma } from "@prisma/client";
import { AccountingError, reverseJournal } from "./accounting";

/**
 * Sumber jurnal: mana yang boleh dibalik dari menu Jurnal umum, dan ke mana tautan "Buka sumber".
 *
 * Jurnal dari menu lain (Transaksi, pembelian, gaji, penjualan, sisihan, withdraw, ...) punya dokumen sumber
 * yang ikut berubah saat dibatalkan (status transaksi, sisa hutang, stok, baris tertaut). Membaliknya langsung
 * dari Jurnal umum membuat dokumen sumber tidak sinkron dengan saldo akun, jadi harus dibatalkan dari menunya.
 */
export const REVERSIBLE_FROM_JOURNAL = ["MANUAL", "PENYESUAIAN", "SALDO_AWAL"] as const;

export function canReverseFromJournal(j: { source: string; reversalOfId: string | null }) {
  return !j.reversalOfId && (REVERSIBLE_FROM_JOURNAL as readonly string[]).includes(j.source);
}

export const SOURCE_LABEL: Record<string, string> = {
  FINANCE: "Transaksi",
  WITHDRAW_PENJUALAN: "Withdraw",
  WD_DITERIMA: "Withdraw diterima",
  PENJUALAN: "Penjualan",
  PEMBELIAN: "Pembelian",
  PAYROLL: "Gaji",
  PAYROLL_AKRUAL: "Akrual gaji",
  KASBON: "Kasbon",
  BORONGAN: "Borongan",
  SISIHAN: "Dana sisihan",
  PIUTANG: "Piutang",
  UTANG: "Hutang",
  PINJAMAN: "Pinjaman",
  ASET: "Aset tetap",
  PENYUSUTAN: "Penyusutan",
  PRODUKSI: "Produksi",
  STOK: "Stok",
  BB: "Bahan baku",
  MANUAL: "Manual",
  PENYESUAIAN: "Penyesuaian",
  SALDO_AWAL: "Saldo awal",
  PEMBALIK: "Pembalik",
};

/** Halaman menu sumber (tanpa query DB). `docId` = id dokumen bila sudah diketahui (mis. id transaksi/penjualan). */
export function sourceHref(source: string, sourceId: string | null, docId?: string | null): string | null {
  switch (source) {
    case "FINANCE":
    case "WITHDRAW_PENJUALAN":
    case "WD_DITERIMA":
      return sourceId ? `/finance/${sourceId}` : "/finance";
    case "PENJUALAN":
      return docId ? `/penjualan/${docId}` : "/penjualan";
    case "PEMBELIAN":
      return "/stok/pembelian";
    case "PAYROLL":
    case "PAYROLL_AKRUAL":
      return sourceId ? `/gaji/${sourceId}` : "/gaji";
    case "KASBON":
      return "/gaji/kasbon";
    case "BORONGAN":
      return "/borongan";
    case "SISIHAN":
      return "/finance/sisihan";
    case "PIUTANG":
    case "UTANG":
    case "PINJAMAN":
      return "/akuntansi/piutang-utang";
    case "ASET":
    case "PENYUSUTAN":
      return "/akuntansi/aset";
    case "PRODUKSI":
      return "/produksi";
    case "STOK":
    case "BB":
      return "/stok/mutasi";
    default:
      return null;
  }
}

/** Balik jurnal dari menu Jurnal umum: hanya jurnal manual/penyesuaian/saldo awal; jurnal pembalik tidak bisa dibalik lagi. */
export async function reverseFromJournalMenu(tx: Prisma.TransactionClient, id: string, date: Date, actor: { id: string; name: string }, reason: string) {
  // Kunci baris dulu agar dua klik bersamaan tidak membuat dua pembalik
  await tx.$queryRaw`SELECT id FROM "Journal" WHERE id = ${id} FOR UPDATE`;
  const orig = await tx.journal.findUniqueOrThrow({ where: { id } });
  if (orig.reversalOfId) throw new AccountingError(`${orig.number} adalah jurnal pembalik dan tidak bisa dibalik lagi dari Jurnal umum`);
  if (!canReverseFromJournal(orig)) {
    throw new AccountingError(`${orig.number} berasal dari menu ${SOURCE_LABEL[orig.source] ?? orig.source}. Batalkan dari menu tersebut agar dokumennya ikut berubah.`);
  }
  return reverseJournal(tx, id, date, actor, reason);
}
