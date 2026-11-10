import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { jakartaDateTime } from "./time";

export type FinanceListParams = Record<string, string | undefined>;

/**
 * Filter daftar Transaksi (/finance) — dipakai halaman dan unduhan Excel agar hasilnya selalu sama.
 * Status (tab) tidak termasuk di sini; ditambahkan pemanggil.
 */
export async function financeWhere(sp: FinanceListParams): Promise<Prisma.FinanceTransactionWhereInput> {
  const sellerIds = sp.direction === "WD" ? (await prisma.bankAccount.findMany({ where: { marketplace: true }, select: { id: true } })).map((b) => b.id) : [];
  // ?sembunyi=1 → hanya transaksi Dibatalkan/Ditolak yang pernah disembunyikan dari daftar
  const hidden = sp.sembunyi === "1";
  return {
    deletedAt: hidden ? { not: null } : null,
    // Sumber: Manual/Telegram/AI = transaksi menu ini; "LAIN" = baris tertaut dari menu lain (pembelian, gaji, ...)
    ...(sp.source === "LAIN" ? { origin: { not: null } } : sp.source ? { source: sp.source as never, origin: null } : {}),
    ...(sp.direction === "WD" ? { direction: "TRANSFER" as const, accountId: { in: sellerIds } } : sp.direction ? { direction: sp.direction as never } : {}),
    ...(sp.store ? { storeId: sp.store } : {}),
    ...(sp.from || sp.to ? { date: { ...(sp.from ? { gte: jakartaDateTime(sp.from, "00:00") } : {}), ...(sp.to ? { lt: new Date(jakartaDateTime(sp.to, "00:00").getTime() + 86400000) } : {}) } } : {}),
    // Filter rekening & kata kunci sama-sama OR, jadi digabung dengan AND agar tidak saling menimpa
    AND: [
      ...(sp.account ? [{ OR: [{ accountId: sp.account }, { toAccountId: sp.account }] }] : []),
      ...(sp.q ? [{ OR: [{ number: { contains: sp.q, mode: "insensitive" as const } }, { note: { contains: sp.q, mode: "insensitive" as const } }, { counterparty: { contains: sp.q, mode: "insensitive" as const } }] }] : []),
    ],
  };
}

/** Jumlah baris awal di daftar Transaksi; "Tampilkan lebih banyak" menambah sebanyak ini */
export const FINANCE_PAGE = 50;
export const FINANCE_MAX = 2000;
export const financeTake = (n?: string) => Math.min(FINANCE_MAX, Math.max(FINANCE_PAGE, Math.floor(Number(n) / FINANCE_PAGE) * FINANCE_PAGE || FINANCE_PAGE));
