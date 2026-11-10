import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { toCsv } from "@/lib/csv";
import { STATUS_LABEL } from "@/lib/finance";
import { financeWhere, FINANCE_MAX } from "@/lib/financeList";
import { originLabel } from "@/lib/txMirror";
import { fmtDateTime, todayStr } from "@/lib/time";
import type { TxStatus } from "@prisma/client";

/**
 * Unduh Excel (CSV) daftar Transaksi sesuai filter & tab yang aktif. Dibuat di server saat tombol ditekan,
 * sehingga data unduhan tidak ikut terkirim setiap kali halaman/tab dibuka.
 */
export async function GET(req: Request) {
  await requirePerm("finance.view");
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries()) as Record<string, string | undefined>;
  const status = sp.status && sp.status in STATUS_LABEL ? (sp.status as TxStatus) : undefined;
  const where = await financeWhere(sp);
  const [rows, banks, cats, stores] = await Promise.all([
    prisma.financeTransaction.findMany({ where: { ...where, ...(status ? { status } : {}) }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: FINANCE_MAX, include: { payable: { select: { kind: true, vendor: true } } } }),
    prisma.bankAccount.findMany(),
    prisma.txCategory.findMany(),
    prisma.store.findMany(),
  ]);
  const name = (list: { id: string; name: string }[], id: string | null) => list.find((x) => x.id === id)?.name ?? "—";
  const isWd = (t: { direction: string; accountId: string | null }) => t.direction === "TRANSFER" && !!banks.find((b) => b.id === t.accountId)?.marketplace;
  const cat = (t: (typeof rows)[number]) =>
    t.origin ? (originLabel(t.origin, t.direction) ?? "—") : isWd(t) ? "Pemasukan penjualan" : t.payable ? `${t.payable.kind === "PINJAMAN" ? "Cicilan pinjaman" : "Bayar hutang"} · ${t.payable.vendor}` : name(cats, t.categoryId);
  const csv = toCsv([
    ["Nomor", "Tanggal", "Arah", "Jumlah (Rp)", "Rekening", "Ke rekening", "Kategori", "Toko", "Pihak", "Catatan", "Status"],
    ...rows.map((t) => [t.number, fmtDateTime(t.date), t.direction, Number(t.amount), name(banks, t.accountId), t.toAccountId ? name(banks, t.toAccountId) : "", cat(t), t.storeId ? name(stores, t.storeId) : "", t.counterparty ?? "", t.note ?? "", STATUS_LABEL[t.status]]),
  ]);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="transaksi-${todayStr()}.csv"`,
      "cache-control": "no-store",
    },
  });
}
