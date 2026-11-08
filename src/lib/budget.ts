import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { AccountingError } from "./accounting";
import { jakartaParts, monthRange, MONTHS } from "./time";

type Tx = Prisma.TransactionClient | typeof prisma;
type Actor = { id: string; name: string };

/** Ambang peringatan anggaran (persen realisasi terhadap anggaran) */
export const BUDGET_WARN = 80;
export const BUDGET_OVER = 100;
/** Tipe akun yang bisa dianggarkan */
export const BUDGET_TYPES = ["BEBAN", "HPP"] as const;

export type BudgetLevel = "AMAN" | "WASPADA" | "LEWAT" | "TANPA";
export type BudgetRow = { accountId: string; code: string; name: string; type: string; budgetId: string | null; budget: number; actual: number; remaining: number; pct: number | null; level: BudgetLevel; note: string | null };

export const monthLabel = (year: number, month: number) => `${MONTHS[month - 1]} ${year}`;

export function currentMonth(now: Date = new Date()) {
  const p = jakartaParts(now);
  return { year: p.year, month: p.month };
}

export function prevMonth(year: number, month: number) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** Bulan dari query "YYYY-MM" (default bulan berjalan WIB) */
export function parseMonth(s: string | undefined | null, now: Date = new Date()) {
  const m = s && /^(\d{4})-(\d{2})$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return { year: +m[1], month: +m[2] };
  return currentMonth(now);
}

export const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

export function levelOf(budget: number, actual: number): { pct: number | null; level: BudgetLevel } {
  if (budget <= 0) return { pct: null, level: actual > 0 ? "TANPA" : "AMAN" };
  const pct = Math.round((actual / budget) * 1000) / 10;
  return { pct, level: pct >= BUDGET_OVER ? "LEWAT" : pct >= BUDGET_WARN ? "WASPADA" : "AMAN" };
}

/** Realisasi beban per akun (debit − kredit jurnal, sudah termasuk jurnal pembalik) dalam satu bulan WIB */
export async function actualByAccount(year: number, month: number, tx: Tx = prisma) {
  const { start, end } = monthRange(year, month);
  const sums = await tx.journalLine.groupBy({
    by: ["accountId"],
    where: { journal: { date: { gte: start, lt: end } }, account: { type: { in: [...BUDGET_TYPES] } } },
    _sum: { debit: true, credit: true },
  });
  return new Map(sums.map((s) => [s.accountId, Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0)]));
}

/**
 * Realisasi vs anggaran satu bulan. Baris = semua akun yang punya anggaran, ditambah akun beban
 * yang ada realisasi tapi belum dianggarkan (level TANPA).
 */
export async function budgetReport(year: number, month: number) {
  const [budgets, actual] = await Promise.all([
    prisma.expenseBudget.findMany({ where: { year, month }, include: { account: true } }),
    actualByAccount(year, month),
  ]);
  const rows: BudgetRow[] = budgets.map((b) => {
    const budget = Number(b.amount);
    const act = actual.get(b.accountId) ?? 0;
    return { accountId: b.accountId, code: b.account.code, name: b.account.name, type: b.account.type, budgetId: b.id, budget, actual: act, remaining: budget - act, ...levelOf(budget, act), note: b.note };
  });
  const budgeted = new Set(budgets.map((b) => b.accountId));
  const missing = [...actual.entries()].filter(([id, v]) => !budgeted.has(id) && v !== 0).map(([id]) => id);
  if (missing.length) {
    const accs = await prisma.coaAccount.findMany({ where: { id: { in: missing } } });
    for (const a of accs) {
      const act = actual.get(a.id) ?? 0;
      rows.push({ accountId: a.id, code: a.code, name: a.name, type: a.type, budgetId: null, budget: 0, actual: act, remaining: -act, ...levelOf(0, act), note: null });
    }
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));
  const totalBudget = rows.reduce((s, r) => s + r.budget, 0);
  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const budgetedActual = rows.filter((r) => r.budgetId).reduce((s, r) => s + r.actual, 0);
  return { year, month, rows, totalBudget, totalActual, budgetedActual, total: levelOf(totalBudget, budgetedActual) };
}

/** Simpan (buat/ubah) anggaran satu akun untuk satu bulan */
export async function saveBudget(input: { year: number; month: number; accountId: string; amount: number; note?: string | null }, actor: Actor) {
  if (!(input.month >= 1 && input.month <= 12) || input.year < 2000) throw new AccountingError("Bulan anggaran tidak valid");
  if (!(input.amount > 0)) throw new AccountingError("Nominal anggaran harus lebih dari 0");
  const acc = await prisma.coaAccount.findUnique({ where: { id: input.accountId } });
  if (!acc || !(BUDGET_TYPES as readonly string[]).includes(acc.type)) throw new AccountingError("Pilih akun beban (tipe BEBAN atau HPP)");
  const key = { year: input.year, month: input.month, accountId: input.accountId };
  const data = { amount: BigInt(Math.round(input.amount)), note: input.note || null };
  const b = await prisma.expenseBudget.upsert({ where: { year_month_accountId: key }, create: { ...key, ...data, createdBy: actor.name }, update: data });
  await audit(actor, "ANGGARAN_DISIMPAN", "ExpenseBudget", b.id, { ...key, amount: input.amount, account: acc.code });
  return b;
}

export async function deleteBudget(id: string, actor: Actor) {
  const b = await prisma.expenseBudget.delete({ where: { id } });
  await audit(actor, "ANGGARAN_DIHAPUS", "ExpenseBudget", id, { year: b.year, month: b.month, accountId: b.accountId, amount: b.amount });
  return b;
}

/** Salin anggaran bulan sebelumnya ke bulan ini. Akun yang sudah punya anggaran di bulan tujuan tidak ditimpa. */
export async function copyBudgetFromPrev(year: number, month: number, actor: Actor) {
  const p = prevMonth(year, month);
  const [src, existing] = await Promise.all([
    prisma.expenseBudget.findMany({ where: { year: p.year, month: p.month, account: { active: true } } }),
    prisma.expenseBudget.findMany({ where: { year, month }, select: { accountId: true } }),
  ]);
  if (!src.length) throw new AccountingError(`Belum ada anggaran di ${monthLabel(p.year, p.month)} untuk disalin`);
  const have = new Set(existing.map((e) => e.accountId));
  const todo = src.filter((s) => !have.has(s.accountId));
  if (todo.length) {
    await prisma.expenseBudget.createMany({ data: todo.map((s) => ({ year, month, accountId: s.accountId, amount: s.amount, note: s.note, createdBy: actor.name })), skipDuplicates: true });
  }
  await audit(actor, "ANGGARAN_DISALIN", "ExpenseBudget", monthKey(year, month), { from: monthKey(p.year, p.month), copied: todo.length, skipped: src.length - todo.length });
  return { copied: todo.length, skipped: src.length - todo.length };
}

/** Akun yang realisasinya sudah ≥80% / ≥100% anggaran pada bulan berjalan (untuk dashboard & bot) */
export async function budgetWarnings(now: Date = new Date()) {
  const { year, month } = currentMonth(now);
  const r = await budgetReport(year, month);
  const flagged = r.rows.filter((x) => x.budgetId && (x.level === "WASPADA" || x.level === "LEWAT"));
  return { year, month, over: flagged.filter((x) => x.level === "LEWAT"), warn: flagged.filter((x) => x.level === "WASPADA") };
}

const settingKey = (year: number, month: number, accountId: string) => `budget_alert:${monthKey(year, month)}:${accountId}`;

/**
 * Peringatan anggaran yang belum pernah dikirim: tiap akun hanya sekali per ambang per bulan
 * (80% lalu 100%; bila langsung lewat 100%, cukup peringatan 100%).
 */
export async function pendingBudgetNotices(now: Date = new Date()) {
  const w = await budgetWarnings(now);
  const rows = [...w.over, ...w.warn];
  if (!rows.length) return { ...w, items: [] as (BudgetRow & { threshold: number })[] };
  const sent = await prisma.setting.findMany({ where: { key: { in: rows.map((r) => settingKey(w.year, w.month, r.accountId)) } } });
  const last = new Map(sent.map((s) => [s.key, Number(s.value) || 0]));
  const items = rows
    .map((r) => ({ ...r, threshold: r.level === "LEWAT" ? BUDGET_OVER : BUDGET_WARN }))
    .filter((r) => (last.get(settingKey(w.year, w.month, r.accountId)) ?? 0) < r.threshold);
  return { ...w, items };
}

export async function markBudgetNoticed(year: number, month: number, items: { accountId: string; threshold: number }[]) {
  for (const i of items) {
    const key = settingKey(year, month, i.accountId);
    await prisma.setting.upsert({ where: { key }, create: { key, value: String(i.threshold) }, update: { value: String(i.threshold) } });
  }
}

export function budgetNoticeText(year: number, month: number, items: (BudgetRow & { threshold: number })[], esc: (s: string) => string, idr: (n: number) => string) {
  if (!items.length) return "";
  const line = (r: BudgetRow) => `• ${esc(r.code)} ${esc(r.name)}: ${idr(r.actual)} dari ${idr(r.budget)} (${r.pct}%)`;
  const over = items.filter((i) => i.threshold === BUDGET_OVER);
  const warn = items.filter((i) => i.threshold === BUDGET_WARN);
  return [
    `<b>⚠️ Peringatan anggaran beban · ${monthLabel(year, month)}</b>`,
    ...(over.length ? ["", `<b>🔴 Sudah melewati anggaran (≥${BUDGET_OVER}%)</b>`, ...over.map(line)] : []),
    ...(warn.length ? ["", `<b>🟠 Mendekati anggaran (≥${BUDGET_WARN}%)</b>`, ...warn.map(line)] : []),
    "",
    "Rincian: menu Akuntansi → Anggaran beban.",
  ].join("\n");
}
