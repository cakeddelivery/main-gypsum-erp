import crypto from "node:crypto";
import type { Prisma, TxDirection } from "@prisma/client";
import { nextNumber } from "./numbering";
import { dateStr } from "./time";

/**
 * Baris Transaksi tertaut: uang rekening yang dibukukan di menu lain (pembelian, gaji, kasbon, borongan, dana sisihan,
 * penjualan, pinjaman, piutang, aset) ikut tampil sebagai baris di menu Transaksi. Jurnalnya tetap SATU (jurnal menu
 * sumber, disimpan di journalId); baris ini hanya cermin untuk daftar, cek duplikat, dan pencarian.
 * Saldo & laporan tetap dihitung dari jurnal, jadi tidak pernah terhitung dua kali.
 * Dibuat otomatis saat jurnal sumber dibukukan, dan otomatis Dibatalkan saat jurnalnya dibalik.
 */
type Tx = Prisma.TransactionClient;

export const MIRROR_SOURCES: Record<string, { label: string; href: (ref: string | null) => string }> = {
  PEMBELIAN: { label: "Pembelian", href: () => "/stok/pembelian" },
  PINJAMAN: { label: "Pinjaman masuk", href: () => "/akuntansi/piutang-utang" },
  UTANG: { label: "Bayar hutang", href: () => "/akuntansi/piutang-utang" },
  PIUTANG: { label: "Piutang", href: () => "/akuntansi/piutang-utang" },
  PAYROLL: { label: "Gaji", href: (r) => (r ? `/gaji/${r}` : "/gaji") },
  KASBON: { label: "Kasbon", href: () => "/gaji/kasbon" },
  BORONGAN: { label: "Upah borongan", href: () => "/borongan" },
  SISIHAN: { label: "Dana sisihan", href: () => "/finance/sisihan" },
  PENJUALAN: { label: "Penjualan", href: () => "/penjualan" },
  ASET: { label: "Aset tetap", href: () => "/akuntansi/aset" },
};

/** Label asal baris tertaut. Sisihan harian yang dicatat sistem (transfer rekening asal → simpanan) = "Sisihan otomatis" */
export const originLabel = (o: string | null | undefined, direction?: string | null) =>
  o === "SISIHAN" && direction === "TRANSFER" ? "Sisihan otomatis" : o ? MIRROR_SOURCES[o]?.label ?? o : null;
export const originHref = (o: string | null | undefined, ref: string | null | undefined) => (o && MIRROR_SOURCES[o] ? MIRROR_SOURCES[o].href(ref ?? null) : null);

export function fingerprint(direction: string, amount: number, date: Date, accountId?: string | null) {
  return crypto.createHash("sha256").update(`${direction}|${amount}|${dateStr(date)}|${accountId ?? "-"}`).digest("hex").slice(0, 32);
}

/**
 * Nomor transaksi berikutnya (TRX-YYYYMM-NNNN). Penghitungnya atomik dan baris Counter terkunci sampai transaksi
 * database selesai, jadi dua permintaan bersamaan (scheduler + pengguna) tidak mendapat nomor sama. Nomor yang
 * sudah dipakai di luar penghitung (mis. diatur skrip koreksi) dilewati, bukan menggagalkan simpan.
 */
export async function nextTxNumber(tx: Tx, at: Date) {
  for (let i = 0; i < 100; i++) {
    const n = await nextNumber(tx, "TRX", at);
    if (!(await tx.financeTransaction.findUnique({ where: { number: n }, select: { id: true } }))) return n;
  }
  throw new Error("Nomor transaksi tidak tersedia");
}

export type MirrorRow = { direction: TxDirection; amount: number; accountId: string; toAccountId: string | null; key: string };

/** Gerakan rekening dari baris jurnal: satu keluar + satu masuk sama besar = transfer; selain itu per rekening */
export function bankMoves(journalId: string, lines: { accountId: string; debit: bigint | number; credit: bigint | number }[], banks: { id: string; coaAccountId: string }[]): MirrorRow[] {
  const net = new Map<string, number>();
  for (const l of lines) {
    const b = banks.find((x) => x.coaAccountId === l.accountId);
    if (b) net.set(b.id, (net.get(b.id) ?? 0) + Number(l.debit) - Number(l.credit));
  }
  const moves = [...net].filter(([, v]) => v !== 0);
  const outs = moves.filter(([, v]) => v < 0);
  const ins = moves.filter(([, v]) => v > 0);
  if (outs.length === 1 && ins.length === 1 && -outs[0][1] === ins[0][1]) {
    return [{ direction: "TRANSFER", amount: ins[0][1], accountId: outs[0][0], toAccountId: ins[0][0], key: `jrn:${journalId}` }];
  }
  return moves.map(([bankId, v]) => ({ direction: v > 0 ? "MASUK" : "KELUAR", amount: Math.abs(v), accountId: bankId, toAccountId: null, key: `jrn:${journalId}:${bankId}` }));
}

/** Nomor dokumen sumber untuk tautan (pembelian, kasbon, penjualan, dll. memakai nomor; gaji memakai id periode) */
function originRef(source: string, sourceId: string | null) {
  if (!sourceId) return null;
  return source === "SISIHAN" ? null : sourceId;
}

/** Buat baris Transaksi tertaut untuk jurnal sumber (aman dipanggil ulang: kunci per jurnal + rekening) */
export async function mirrorJournal(tx: Tx, journalId: string, opts: { status?: "DIBUKUKAN" | "DIBATALKAN" } = {}) {
  const j = await tx.journal.findUniqueOrThrow({ where: { id: journalId }, include: { lines: true } });
  if (!MIRROR_SOURCES[j.source] || j.reversalOfId) return [];
  const banks = await tx.bankAccount.findMany({ select: { id: true, coaAccountId: true, name: true }, orderBy: [{ active: "desc" }, { code: "asc" }] });
  const rows = bankMoves(j.id, j.lines, banks);
  if (!rows.length) return [];
  const ref = originRef(j.source, j.sourceId);
  const out = [];
  for (const r of rows) {
    if (await tx.financeTransaction.findUnique({ where: { idempotencyKey: r.key } })) continue;
    const status = opts.status ?? "DIBUKUKAN";
    const number = await nextTxNumber(tx, j.date);
    const t = await tx.financeTransaction.create({
      data: {
        number,
        source: "MANUAL",
        direction: r.direction,
        amount: BigInt(r.amount),
        date: j.date,
        accountId: r.accountId,
        toAccountId: r.toAccountId,
        storeId: j.storeId,
        note: j.description.slice(0, 500),
        status,
        fingerprint: fingerprint(r.direction, r.amount, j.date, r.accountId),
        idempotencyKey: r.key,
        journalId: j.id,
        createdBy: j.createdBy,
        origin: j.source,
        originRef: ref,
      },
    });
    await tx.approvalLog.create({ data: { transactionId: t.id, action: "DIBUAT", toStatus: status, actorName: j.createdBy, note: `Tertaut dari ${originLabel(j.source, r.direction)} (jurnal ${j.number})` } });
    out.push(t);
  }
  return out;
}

/** Jurnal sumber dibalik (dibatalkan di menunya): baris tertautnya ikut Dibatalkan */
export async function cancelMirrors(tx: Tx, journalId: string, reversalNumber: string, actorName: string) {
  const rows = await tx.financeTransaction.findMany({ where: { journalId, origin: { not: null }, status: "DIBUKUKAN" }, select: { id: true } });
  if (!rows.length) return 0;
  await tx.financeTransaction.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "DIBATALKAN" } });
  await tx.approvalLog.createMany({ data: rows.map((r) => ({ transactionId: r.id, action: "DIBATALKAN", fromStatus: "DIBUKUKAN" as const, toStatus: "DIBATALKAN" as const, actorName, note: `Dibatalkan di menu sumber (jurnal pembalik ${reversalNumber})` })) });
  return rows.length;
}
