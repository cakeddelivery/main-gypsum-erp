import type { ReserveKind } from "@prisma/client";
import { prisma } from "./db";
import { postJournal, COA, type LineInput } from "./accounting";
import { audit } from "./audit";
import { addDays, dateOnly, dateStr, jakartaDateTime, todayStr } from "./time";
import { FinanceError } from "./finance";
import { liabilityAccountId, payableLines, splitPayment } from "./payables";
import { reserveOptions, type ReserveOption } from "./reserveSync";

type Actor = { id: string; name: string };

export const RESERVE_LABEL: Record<ReserveKind, string> = {
  OWNER: "Kompensasi pengelola (owner)",
  LOAN_SAVING: "Tabungan cicilan pinjaman",
  LOAN_PAYMENT: "Cicilan pinjaman harian",
};

/**
 * Baris jurnal penyisihan harian:
 * - OWNER: Dr Beban Kompensasi Pengelola / Cr Hutang Kompensasi Pengelola, dan uangnya dipindah rekening asal → ShopeePay
 * - LOAN_SAVING: pindah rekening asal → rekening simpanan (hutang belum berkurang)
 * - LOAN_PAYMENT: Dr Hutang Pinjaman Modal / Cr rekening asal (hutang langsung berkurang)
 */
export function reserveLines(kind: ReserveKind, amount: number, fromCoa: string, toCoa: string | null): LineInput[] {
  if (kind === "LOAN_PAYMENT") return [{ accountCode: COA.UTANG_PINJAMAN, debit: amount }, { accountId: fromCoa, credit: amount }];
  if (!toCoa) throw new FinanceError("Rekening tujuan sisihan belum diatur");
  const move: LineInput[] = [{ accountId: toCoa, debit: amount, memo: "Dana disisihkan" }, { accountId: fromCoa, credit: amount }];
  if (kind === "LOAN_SAVING") return move;
  return [{ accountCode: COA.BEBAN_GAJI_OWNER, debit: amount }, { accountCode: COA.UTANG_GAJI_OWNER, credit: amount }, ...move];
}

/** Catat sisihan satu dana untuk satu tanggal (sekali per hari per dana) */
export type Proof = { path: string; mime: string } | null;

export async function postReserve(fundId: string, date: string, actor: Actor, amountOverride?: number, proof: Proof = null) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ReserveFund" WHERE id = ${fundId} FOR UPDATE`;
    const f = await tx.reserveFund.findUniqueOrThrow({ where: { id: fundId } });
    if (await tx.reserveEntry.findFirst({ where: { fundId, date: dateOnly(date), type: "SISIH" } })) throw new FinanceError(`${f.name} sudah disisihkan untuk ${date}`);
    let amount = amountOverride ?? Number(f.dailyAmount);
    if (!(amount > 0)) throw new FinanceError("Nominal sisihan harus > 0");
    const from = await tx.bankAccount.findUniqueOrThrow({ where: { id: f.fromBankId } });
    const to = f.toBankId ? await tx.bankAccount.findUniqueOrThrow({ where: { id: f.toBankId } }) : null;
    if (f.kind === "LOAN_PAYMENT") {
      if (!f.payableId) throw new FinanceError("Pilih pinjaman yang dicicil");
      const loan = await tx.payable.findUniqueOrThrow({ where: { id: f.payableId } });
      amount = Math.min(amount, Number(loan.amount - loan.paid));
      if (amount <= 0) throw new FinanceError(`Pinjaman ${loan.number} sudah lunas`);
      await tx.payable.update({ where: { id: loan.id }, data: { paid: { increment: BigInt(amount) } } });
    }
    const j = await postJournal(tx, { date: jakartaDateTime(date, "18:00"), storeId: f.storeId, description: `Sisihan harian ${f.name}`, source: "SISIHAN", sourceId: f.id, actor, lines: reserveLines(f.kind, amount, from.coaAccountId, to?.coaAccountId ?? null) });
    const e = await tx.reserveEntry.create({ data: { fundId, date: dateOnly(date), type: "SISIH", amount: BigInt(amount), journalId: j.id, proofPath: proof?.path ?? null, proofMime: proof?.mime ?? null, createdBy: actor.name } });
    await audit(actor, "SISIHAN_HARIAN", "ReserveFund", fundId, { date, amount }, tx);
    return e;
  });
}

/** Sisihkan semua dana aktif yang belum dicatat pada tanggal tsb */
export async function postAllReserves(date: string, actor: Actor) {
  const funds = await prisma.reserveFund.findMany({ where: { active: true } });
  const done = await prisma.reserveEntry.findMany({ where: { date: dateOnly(date), type: "SISIH" } });
  let count = 0;
  let total = 0;
  for (const f of funds) {
    if (done.some((d) => d.fundId === f.id)) continue;
    const e = await postReserve(f.id, date, actor);
    count++;
    total += Number(e.amount);
  }
  return { count, total };
}

/**
 * Dana dipakai: OWNER = owner mengambil kompensasinya (Dr Hutang Kompensasi / Cr ShopeePay);
 * LOAN_SAVING = tabungan dibayarkan ke pemberi pinjaman (Dr Hutang Pinjaman / Cr rekening simpanan).
 */
export async function withdrawReserve(fundId: string, amount: number, date: string, actor: Actor, note?: string | null, proof: Proof = null, pay: { payableId?: string | null; interest?: number | null } = {}) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ReserveFund" WHERE id = ${fundId} FOR UPDATE`;
    const f = await tx.reserveFund.findUniqueOrThrow({ where: { id: fundId } });
    if (f.kind === "LOAN_PAYMENT") throw new FinanceError("Cicilan harian langsung mengurangi hutang; tidak ada saldo untuk ditarik");
    const bal = await fundBalance(tx, fundId);
    if (!(amount > 0) || amount > bal) throw new FinanceError(`Nominal harus 1 – ${bal}`);
    const to = await tx.bankAccount.findUniqueOrThrow({ where: { id: f.toBankId! } });
    let lines: LineInput[] = [{ accountCode: COA.UTANG_GAJI_OWNER, debit: amount }, { accountId: to.coaAccountId, credit: amount }];
    let desc = `Pengambilan ${f.name}`;
    if (f.kind === "LOAN_SAVING") {
      // Satu tabungan bisa untuk beberapa pinjaman: pinjaman yang dibayar dipilih saat membayar (bawaan: pinjaman di pengaturan dana)
      const loanId = pay.payableId || f.payableId;
      if (!loanId) throw new FinanceError("Pilih pinjaman yang dibayar. Catat pinjamannya di Akuntansi › Piutang, hutang & pinjaman.");
      const loan = await tx.payable.findUniqueOrThrow({ where: { id: loanId } });
      const sp = splitPayment(loan, amount, pay.interest);
      if (sp.interest < 0 || sp.principal <= 0) throw new FinanceError("Bunga harus 0 – kurang dari nominal");
      if (sp.principal > Number(loan.amount - loan.paid)) throw new FinanceError(`Pokok melebihi sisa pinjaman ${loan.number}`);
      await tx.payable.update({ where: { id: loan.id }, data: { paid: { increment: BigInt(sp.principal) } } });
      lines = payableLines(await liabilityAccountId(tx, loan), to.coaAccountId, sp.principal, sp.interest, `Cicilan ${loan.number} ${loan.vendor}`.slice(0, 120));
      desc = `Cicilan ${loan.number} ${loan.vendor} dari ${f.name}`;
    }
    const j = await postJournal(tx, { date: jakartaDateTime(date, "12:00"), storeId: f.storeId, description: desc, source: "SISIHAN", sourceId: f.id, actor, lines });
    await tx.reserveEntry.create({ data: { fundId, date: dateOnly(date), type: "TARIK", amount: BigInt(amount), journalId: j.id, note: note ?? null, proofPath: proof?.path ?? null, proofMime: proof?.mime ?? null, createdBy: actor.name } });
    await audit(actor, "SISIHAN_DITARIK", "ReserveFund", fundId, { amount }, tx);
  });
}

type DB = Parameters<Parameters<typeof prisma.$transaction>[0]>[0] | typeof prisma;

export async function fundBalance(db: DB, fundId: string) {
  const rows = await db.reserveEntry.groupBy({ by: ["type"], where: { fundId }, _sum: { amount: true } });
  const g = (t: string) => Number(rows.find((r) => r.type === t)?._sum.amount ?? 0);
  return g("SISIH") - g("TARIK");
}

/** Ringkasan per dana: saldo, total bulan ini, dan hari yang belum disisihkan (7 hari terakhir) */
export async function reserveSummary(now: Date = new Date()) {
  const today = todayStr(now);
  const monthStart = `${today.slice(0, 8)}01`;
  const funds = await prisma.reserveFund.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }], include: { entries: { where: { date: { gte: dateOnly(addDays(today, -40)) } } } } });
  return Promise.all(
    funds.map(async (f) => {
      const days = new Set(f.entries.filter((e) => e.type === "SISIH").map((e) => dateStr(e.date)));
      const created = todayStr(f.createdAt);
      const missing = f.active ? Array.from({ length: 7 }, (_, i) => addDays(today, -i)).filter((d) => d >= created && !days.has(d)) : [];
      const month = f.entries.filter((e) => e.type === "SISIH" && dateStr(e.date) >= monthStart).reduce((s, e) => s + Number(e.amount), 0);
      return { ...f, balance: await fundBalance(prisma, f.id), month, missing, doneToday: days.has(today) };
    }),
  );
}

/** Lampirkan bukti transfer ke sisihan yang sudah tercatat (tanpa jurnal baru) */
export async function attachReserveProof(entryIds: string[], proof: NonNullable<Proof>, actor: Actor) {
  if (!entryIds.length) return 0;
  const r = await prisma.reserveEntry.updateMany({ where: { id: { in: entryIds } }, data: { proofPath: proof.path, proofMime: proof.mime } });
  // Transfer di menu Transaksi yang menjadi sumber sisihan ini ikut dilampiri bila belum punya bukti
  const txIds = (await prisma.reserveEntry.findMany({ where: { id: { in: entryIds }, transactionId: { not: null } }, select: { transactionId: true } })).map((e) => e.transactionId!);
  if (txIds.length) await prisma.financeTransaction.updateMany({ where: { id: { in: txIds }, proofPath: null }, data: { proofPath: proof.path, proofMime: proof.mime } });
  await audit(actor, "BUKTI_SISIHAN", "ReserveEntry", entryIds.join(","), { count: r.count });
  return r.count;
}

// ---------- Mengenali bukti transfer sisihan dari nominal & rekening ----------
export type { ReserveOption } from "./reserveSync";

/** Tebak dana sisihan dari bukti transfer (lihat reserveOptions) */
export async function matchReserveTransfer(input: { amount: number; fromBankId: string | null; toBankId: string | null; date: string; text?: string }) {
  return reserveOptions(prisma, input);
}

/** Catat sisihan dari bukti transfer: tanggal yang belum disisihkan dicatat, yang sudah tercatat hanya dilampiri bukti */
export async function applyReserveOption(opt: Pick<ReserveOption, "fundIds" | "dates">, proof: Proof, actor: Actor) {
  let posted = 0;
  let attached = 0;
  const existing: string[] = [];
  for (const fundId of opt.fundIds) {
    for (const date of opt.dates) {
      const e = await prisma.reserveEntry.findFirst({ where: { fundId, date: dateOnly(date), type: "SISIH" } });
      if (e) existing.push(e.id);
      else {
        await postReserve(fundId, date, actor, undefined, proof);
        posted++;
      }
    }
  }
  if (proof && existing.length) attached = await attachReserveProof(existing, proof, actor);
  return { posted, attached };
}
