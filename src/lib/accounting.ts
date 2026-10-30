import { Prisma, type AccountType } from "@prisma/client";
import { prisma } from "./db";
import { nextNumber } from "./numbering";
import { jakartaParts, monthRange } from "./time";
import { audit } from "./audit";

type Tx = Prisma.TransactionClient;

/** Kode akun sistem (Chart of Accounts manufaktur, lihat prisma/seed.ts) */
export const COA = {
  KAS: "1-1100",
  PIUTANG: "1-1300",
  PIUTANG_KARYAWAN: "1-1310",
  PERSEDIAAN_BAHAN: "1-1401",
  PERSEDIAAN_BDP: "1-1402",
  PERSEDIAAN_JADI: "1-1403",
  ASET_TETAP: "1-2100",
  AKUM_PENYUSUTAN: "1-2900",
  UTANG_USAHA: "2-1100",
  UTANG_GAJI: "2-1200",
  UTANG_GAJI_OWNER: "2-1210",
  UTANG_PINJAMAN: "2-1400",
  MODAL: "3-1000",
  LABA_DITAHAN: "3-2000",
  EKUITAS_SALDO_AWAL: "3-9000",
  PENJUALAN: "4-1000",
  HPP: "5-1000",
  BEBAN_GAJI_PRODUKSI: "6-1100",
  BEBAN_GAJI_OWNER: "6-1150",
  BEBAN_TRANSPORT: "6-1200",
  BEBAN_PENYUSUTAN: "6-1700",
  BEBAN_SELISIH_PERSEDIAAN: "6-1800",
  BEBAN_LAIN: "6-9000",
} as const;

export type LineInput = { accountId?: string; accountCode?: string; debit?: number; credit?: number; memo?: string };
export type JournalInput = {
  date: Date;
  /** Kosong = toko default. Toko hanya membedakan withdraw saldo marketplace; beban & bahan baku dipakai bersama. */
  storeId?: string | null;
  description: string;
  source: string;
  sourceId?: string | null;
  lines: LineInput[];
  actor: { id: string; name: string };
  reversalOfId?: string;
};

export class AccountingError extends Error {}

/** Toko default (Pengaturan → Toko default transaksi), dipakai untuk semua transaksi selain withdraw marketplace */
export async function defaultStoreId(db: Pick<Tx, "setting" | "store"> = prisma): Promise<string> {
  const s = await db.setting.findUnique({ where: { key: "default_store_id" } });
  return s?.value ?? (await db.store.findFirstOrThrow({ orderBy: { code: "asc" } })).id;
}

export async function assertPeriodOpen(tx: Tx | typeof prisma, date: Date) {
  const p = jakartaParts(date);
  const period = await tx.accountingPeriod.findUnique({ where: { year_month: { year: p.year, month: p.month } } });
  if (period?.status === "CLOSED") {
    throw new AccountingError(`Periode ${String(p.month).padStart(2, "0")}/${p.year} sudah ditutup. Gunakan tanggal di periode terbuka.`);
  }
}

/** Validasi double-entry murni (dipakai juga oleh unit test). */
export function validateLines(lines: LineInput[]) {
  if (lines.length < 2) throw new AccountingError("Jurnal minimal 2 baris");
  let d = 0;
  let c = 0;
  for (const l of lines) {
    const debit = l.debit ?? 0;
    const credit = l.credit ?? 0;
    if (!Number.isInteger(debit) || !Number.isInteger(credit)) throw new AccountingError("Nominal IDR harus bilangan bulat");
    if (debit < 0 || credit < 0) throw new AccountingError("Nominal tidak boleh negatif");
    if ((debit > 0) === (credit > 0)) throw new AccountingError("Setiap baris harus berisi debit ATAU kredit");
    d += debit;
    c += credit;
  }
  if (d !== c) throw new AccountingError(`Jurnal tidak seimbang (debit ${d} ≠ kredit ${c})`);
  if (d === 0) throw new AccountingError("Jurnal bernilai nol");
  return d;
}

/** Bukukan jurnal (harus dipanggil di dalam transaksi database agar atomik). */
export async function postJournal(tx: Tx, input: JournalInput) {
  validateLines(input.lines);
  await assertPeriodOpen(tx, input.date);
  const codes = input.lines.filter((l) => !l.accountId && l.accountCode).map((l) => l.accountCode!);
  const accounts = codes.length ? await tx.coaAccount.findMany({ where: { code: { in: codes } } }) : [];
  const byCode = new Map(accounts.map((a) => [a.code, a.id]));
  const lines = input.lines.map((l) => {
    const accountId = l.accountId ?? byCode.get(l.accountCode!);
    if (!accountId) throw new AccountingError(`Akun ${l.accountCode} tidak ditemukan`);
    return { accountId, debit: BigInt(l.debit ?? 0), credit: BigInt(l.credit ?? 0), memo: l.memo ?? null };
  });
  const number = await nextNumber(tx, "JU", input.date);
  const journal = await tx.journal.create({
    data: {
      number,
      date: input.date,
      storeId: input.storeId || (await defaultStoreId(tx)),
      description: input.description,
      source: input.source,
      sourceId: input.sourceId ?? null,
      createdBy: input.actor.name,
      reversalOfId: input.reversalOfId ?? null,
      lines: { create: lines },
    },
  });
  await audit(input.actor, "JURNAL_DIBUKUKAN", "Journal", journal.id, { number, source: input.source, sourceId: input.sourceId }, tx);
  return journal;
}

/** Koreksi jurnal dengan jurnal pembalik (jurnal asli tidak pernah diubah). */
export async function reverseJournal(tx: Tx, journalId: string, date: Date, actor: { id: string; name: string }, reason: string) {
  const j = await tx.journal.findUniqueOrThrow({ where: { id: journalId }, include: { lines: true } });
  const already = await tx.journal.findFirst({ where: { reversalOfId: j.id } });
  if (already) throw new AccountingError("Jurnal ini sudah pernah dibalik");
  return postJournal(tx, {
    date,
    storeId: j.storeId,
    description: `Pembalik ${j.number}: ${reason}`,
    source: "PEMBALIK",
    sourceId: j.id,
    reversalOfId: j.id,
    actor,
    lines: j.lines.map((l) => ({ accountId: l.accountId, debit: Number(l.credit), credit: Number(l.debit), memo: l.memo ?? undefined })),
  });
}

// ---------------- LAPORAN ----------------

export type Range = { start?: Date; end?: Date; storeId?: string | null };

function normalSign(type: AccountType, code: string) {
  // Akumulasi penyusutan = kontra aset (saldo normal kredit)
  if (code === COA.AKUM_PENYUSUTAN) return -1;
  return type === "ASET" || type === "HPP" || type === "BEBAN" ? 1 : -1;
}

/** Saldo per akun (debit - kredit) dalam rentang waktu & toko */
export async function accountBalances(r: Range) {
  const where: Prisma.JournalLineWhereInput = {
    journal: {
      date: { ...(r.start ? { gte: r.start } : {}), ...(r.end ? { lt: r.end } : {}) },
      ...(r.storeId ? { storeId: r.storeId } : {}),
    },
  };
  const sums = await prisma.journalLine.groupBy({ by: ["accountId"], where, _sum: { debit: true, credit: true } });
  const accounts = await prisma.coaAccount.findMany({ orderBy: { code: "asc" } });
  const map = new Map(sums.map((s) => [s.accountId, Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0)]));
  return accounts.map((a) => {
    const net = map.get(a.id) ?? 0;
    return { ...a, net, balance: net * normalSign(a.type, a.code) };
  });
}

export async function trialBalance(r: Range) {
  const rows = await accountBalances(r);
  return rows
    .filter((a) => a.net !== 0)
    .map((a) => ({ code: a.code, name: a.name, type: a.type, debit: a.net > 0 ? a.net : 0, credit: a.net < 0 ? -a.net : 0 }));
}

export async function profitLoss(r: Range) {
  const rows = await accountBalances(r);
  const pick = (t: AccountType) => rows.filter((a) => a.type === t && a.balance !== 0).map((a) => ({ code: a.code, name: a.name, amount: a.balance }));
  const revenue = pick("PENDAPATAN");
  const cogs = pick("HPP");
  const expenses = pick("BEBAN");
  const sum = (x: { amount: number }[]) => x.reduce((s, a) => s + a.amount, 0);
  const totalRevenue = sum(revenue);
  const totalCogs = sum(cogs);
  const totalExpenses = sum(expenses);
  const grossProfit = totalRevenue - totalCogs;
  return { revenue, cogs, expenses, totalRevenue, totalCogs, totalExpenses, grossProfit, netProfit: grossProfit - totalExpenses };
}

export async function balanceSheet(asOf: Date, storeId?: string | null) {
  const rows = await accountBalances({ end: asOf, storeId });
  const pick = (t: AccountType) => rows.filter((a) => a.type === t && a.net !== 0).map((a) => ({ code: a.code, name: a.name, amount: a.code === COA.AKUM_PENYUSUTAN ? -a.balance : a.balance }));
  const assets = pick("ASET");
  const liabilities = pick("KEWAJIBAN");
  const equity = pick("EKUITAS");
  const pl = await profitLoss({ end: asOf, storeId });
  const sum = (x: { amount: number }[]) => x.reduce((s, a) => s + a.amount, 0);
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity) + pl.netProfit;
  return { assets, liabilities, equity, currentEarnings: pl.netProfit, totalAssets, totalLiabilities, totalEquity, balanced: totalAssets === totalLiabilities + totalEquity };
}

/** Arus kas metode langsung dari akun kas/bank. Transfer antar rekening saling meniadakan. */
export async function cashFlow(r: Range) {
  const journals = await prisma.journal.findMany({
    where: { date: { ...(r.start ? { gte: r.start } : {}), ...(r.end ? { lt: r.end } : {}) }, ...(r.storeId ? { storeId: r.storeId } : {}) },
    include: { lines: { include: { account: true } } },
    orderBy: { date: "asc" },
  });
  const groups: Record<"OPERASI" | "INVESTASI" | "PENDANAAN", { date: Date; number: string; memo: string; description: string; amount: number }[]> = { OPERASI: [], INVESTASI: [], PENDANAAN: [] };
  for (const j of journals) {
    const cashLines = j.lines.filter((l) => l.account.isCash);
    if (!cashLines.length) continue;
    const net = cashLines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    if (net === 0) continue; // transfer internal
    const other = j.lines.filter((l) => !l.account.isCash).sort((a, b) => Number(b.debit + b.credit) - Number(a.debit + a.credit))[0];
    let g: keyof typeof groups = "OPERASI";
    if (other) {
      if (other.account.type === "ASET" && other.account.code.startsWith("1-2")) g = "INVESTASI";
      else if (other.account.type === "EKUITAS" && other.account.code !== COA.EKUITAS_SALDO_AWAL) g = "PENDANAAN";
      else if (other.account.code === COA.UTANG_PINJAMAN) g = "PENDANAAN";
    }
    if (j.source === "SALDO_AWAL") continue;
    groups[g].push({ date: j.date, number: j.number, memo: j.description, description: `${j.number} · ${j.description}`, amount: net });
  }
  const total = (k: keyof typeof groups) => groups[k].reduce((s, x) => s + x.amount, 0);
  const opening = r.start ? await cashBalance(r.start, r.storeId) : 0;
  const closing = r.end ? await cashBalance(r.end, r.storeId) : await cashBalance(new Date(8.64e15), r.storeId);
  return { groups, operating: total("OPERASI"), investing: total("INVESTASI"), financing: total("PENDANAAN"), opening, closing };
}

export async function cashBalance(before: Date, storeId?: string | null) {
  const agg = await prisma.journalLine.aggregate({
    where: { account: { isCash: true }, journal: { date: { lt: before }, ...(storeId ? { storeId } : {}) } },
    _sum: { debit: true, credit: true },
  });
  return Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0);
}

export async function ledger(accountId: string, r: Range) {
  const account = await prisma.coaAccount.findUniqueOrThrow({ where: { id: accountId } });
  const sign = normalSign(account.type, account.code);
  const storeWhere = r.storeId ? { storeId: r.storeId } : {};
  let opening = 0;
  if (r.start) {
    const agg = await prisma.journalLine.aggregate({ where: { accountId, journal: { date: { lt: r.start }, ...storeWhere } }, _sum: { debit: true, credit: true } });
    opening = (Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0)) * sign;
  }
  const lines = await prisma.journalLine.findMany({
    where: { accountId, journal: { date: { ...(r.start ? { gte: r.start } : {}), ...(r.end ? { lt: r.end } : {}) }, ...storeWhere } },
    include: { journal: true },
    orderBy: [{ journal: { date: "asc" } }, { journal: { number: "asc" } }],
  });
  let bal = opening;
  const rows = lines.map((l) => {
    bal += (Number(l.debit) - Number(l.credit)) * sign;
    return { id: l.id, date: l.journal.date, number: l.journal.number, description: l.journal.description, memo: l.memo, debit: Number(l.debit), credit: Number(l.credit), balance: bal };
  });
  return { account, opening, rows, closing: bal };
}

// ---------------- TUTUP BUKU ----------------

/** Penyusutan garis lurus bulanan untuk satu aset */
export function monthlyDepreciation(cost: number, residual: number, lifeMonths: number) {
  if (lifeMonths <= 0) return 0;
  return Math.round((cost - residual) / lifeMonths);
}

/** Tutup buku bulanan: posting penyusutan lalu kunci periode. Idempoten. */
export async function closePeriod(year: number, month: number, actor: { id: string; name: string }) {
  const existing = await prisma.accountingPeriod.findUnique({ where: { year_month: { year, month } } });
  if (existing?.status === "CLOSED") return { alreadyClosed: true, depreciation: 0 };
  const { start, end } = monthRange(year, month);
  const lastMoment = new Date(end.getTime() - 1000);
  let depTotal = 0;
  await prisma.$transaction(async (tx) => {
    const assets = await tx.fixedAsset.findMany({ where: { active: true, acquiredAt: { lt: end } } });
    for (const a of assets) {
      const key = `${a.id}:${year}-${month}`;
      if (await tx.journal.findFirst({ where: { source: "PENYUSUTAN", sourceId: key } })) continue;
      const posted = await tx.journal.count({ where: { source: "PENYUSUTAN", sourceId: { startsWith: `${a.id}:` } } });
      if (posted >= a.usefulLifeMonths) continue;
      const amt = monthlyDepreciation(Number(a.cost), Number(a.residual), a.usefulLifeMonths);
      if (amt <= 0) continue;
      await postJournal(tx, {
        date: lastMoment,
        storeId: a.storeId,
        description: `Penyusutan ${a.name} ${String(month).padStart(2, "0")}/${year}`,
        source: "PENYUSUTAN",
        sourceId: key,
        actor,
        lines: [
          { accountCode: COA.BEBAN_PENYUSUTAN, debit: amt },
          { accountCode: COA.AKUM_PENYUSUTAN, credit: amt },
        ],
      });
      depTotal += amt;
    }
    await tx.accountingPeriod.upsert({
      where: { year_month: { year, month } },
      create: { year, month, status: "CLOSED", closedAt: new Date(), closedBy: actor.name },
      update: { status: "CLOSED", closedAt: new Date(), closedBy: actor.name },
    });
    await audit(actor, "TUTUP_BUKU", "AccountingPeriod", `${year}-${month}`, { depreciation: depTotal, start }, tx);
  });
  return { alreadyClosed: false, depreciation: depTotal };
}
