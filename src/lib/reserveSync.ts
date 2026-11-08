import type { Prisma, ReserveFund } from "@prisma/client";
import { prisma } from "./db";
import { assertPeriodOpen, reverseJournal, COA, type LineInput } from "./accounting";
import { addDays, dateOnly, dateStr, todayStr } from "./time";

/**
 * Sinkron transfer di menu Transaksi ↔ Dana sisihan.
 * Transfer dari rekening asal ke rekening simpanan dana sisihan (mis. Seabank → ShopeePay untuk kompensasi
 * Cak Ed & Jojo, atau Seabank → rekening tabungan untuk nabung cicilan SPinjam) = bukti sisihan: saat transaksinya
 * dibukukan, sisihannya ikut tercatat (satu jurnal: jurnal transaksi) dan bukti transfernya ikut terlampir.
 */
type Db = Prisma.TransactionClient | typeof prisma;

export type ReservePart = { fundId: string; date: string; amount: number };
export type ReserveLink = { parts: ReservePart[] } | { skip: true };
export type ReserveOption = { fundIds: string[]; dates: string[]; amount: number; label: string; routeMatch: boolean; parts: ReservePart[] };

export function parseLink(v: unknown): ReserveLink | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { skip?: unknown; parts?: unknown };
  if (o.skip === true) return { skip: true };
  if (!Array.isArray(o.parts) || !o.parts.length) return null;
  const parts = o.parts
    .map((p) => p as Partial<ReservePart>)
    .filter((p): p is ReservePart => typeof p.fundId === "string" && typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number(p.amount) > 0)
    .map((p) => ({ fundId: p.fundId, date: p.date, amount: Math.round(Number(p.amount)) }));
  return parts.length ? { parts } : null;
}

const OWNER_WORDS = /\b(kompensasi|gaji owner|pengelola|owner|ops)\b/i;
const LOAN_WORDS = /\b(nabung|tabung|tabungan|spinjam|cicil|cicilan|pinjam|pinjaman|hutang|utang|angsur)\b/i;
const ANY_WORDS = /\b(sisih|sisihan|disisihkan|nabung|tabung|tabungan|kompensasi|gaji owner|pengelola|spinjam)\b/i;

const idr = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;

/**
 * Kemungkinan dana sisihan untuk satu transfer: rekening asal/tujuan sama dengan alur dana, dan nominal =
 * kelipatan sisihan harian (satu dana, atau beberapa dana sejenis dengan alur sama mis. kompensasi Cak Ed + Jojo).
 * Tabungan cicilan boleh nominal bebas (nabung lebih/kurang dari jatah harian): dicatat di tanggal transfer.
 * Tanggal = hari-hari terakhir s/d tanggal transfer yang belum disisihkan, atau sudah disisihkan tanpa bukti
 * (sisihan tsb lalu memakai transfer ini sebagai bukti & jurnalnya).
 * `sure` = cukup yakin untuk dicatat otomatis; selain itu pengguna memilih.
 */
export async function reserveOptions(db: Db, input: { amount: number; fromBankId: string | null; toBankId: string | null; date: string; text?: string; excludeTxId?: string }) {
  const funds = await db.reserveFund.findMany({ where: { active: true, kind: { in: ["OWNER", "LOAN_SAVING"] } }, orderBy: { name: "asc" } });
  const text = input.text ?? "";
  const keyword = ANY_WORDS.test(text);
  const relevant = funds.filter((f) => (!input.fromBankId || f.fromBankId === input.fromBankId) && (!input.toBankId || f.toBankId === input.toBankId));
  if (!relevant.length || !(input.amount > 0)) return null;
  // Rekening tujuan tidak terbaca & tidak ada kata sisihan: terlalu lemah untuk ditebak
  if (!input.toBankId && !keyword) return null;
  const since = addDays(input.date, -30);
  const entries = await db.reserveEntry.findMany({ where: { fundId: { in: relevant.map((f) => f.id) }, type: "SISIH", date: { gte: dateOnly(since), lte: dateOnly(input.date) } } });
  const isOpen = (f: ReserveFund, d: string) => {
    const e = entries.find((x) => x.fundId === f.id && dateStr(x.date) === d);
    if (!e) return d >= todayStr(f.createdAt);
    if (e.transactionId) return !!input.excludeTxId && e.transactionId === input.excludeTxId;
    return !e.proofPath;
  };
  const openDates = (fs: ReserveFund[]) => {
    const out: string[] = [];
    for (let d = input.date; d >= since; d = addDays(d, -1)) if (fs.every((f) => isOpen(f, d))) out.push(d);
    return out;
  };
  // Dana dikelompokkan per alur + jenis (kompensasi owner tidak dicampur dengan tabungan cicilan)
  const groups = new Map<string, ReserveFund[]>();
  for (const f of relevant) {
    const k = `${f.fromBankId}>${f.toBankId}>${f.kind}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const options: (ReserveOption & { kind: string })[] = [];
  const add = (fs: ReserveFund[]) => {
    const perDay = fs.reduce((t, f) => t + Number(f.dailyAmount), 0);
    if (!(perDay > 0) || input.amount % perDay !== 0) return;
    const days = input.amount / perDay;
    if (days > 31) return;
    const dates = openDates(fs).slice(0, days).sort();
    if (dates.length < days) return;
    const label = `${fs.map((f) => f.name).join(" + ")} · ${days} hari`;
    if (options.some((o) => o.label === label)) return;
    const parts = fs.flatMap((f) => dates.map((date) => ({ fundId: f.id, date, amount: Number(f.dailyAmount) })));
    options.push({ fundIds: fs.map((f) => f.id), dates, amount: input.amount, label, routeMatch: !!input.toBankId, parts, kind: fs[0].kind });
  };
  for (const g of groups.values()) {
    if (g.length > 1) add(g);
    for (const f of g) add([f]);
  }
  // Tabungan cicilan dengan nominal bebas: satu catatan di tanggal transfer
  const savings = relevant.filter((f) => f.kind === "LOAN_SAVING");
  if (savings.length === 1 && !options.some((o) => o.kind === "LOAN_SAVING")) {
    const f = savings[0];
    options.push({ fundIds: [f.id], dates: [input.date], amount: input.amount, label: `${f.name} · ${idr(input.amount)}`, routeMatch: !!input.toBankId, parts: [{ fundId: f.id, date: input.date, amount: input.amount }], kind: "LOAN_SAVING" });
  }
  if (!options.length) return null;
  const prefer = OWNER_WORDS.test(text) && !LOAN_WORDS.test(text) ? "OWNER" : LOAN_WORDS.test(text) && !OWNER_WORDS.test(text) ? "LOAN_SAVING" : null;
  // Kata kunci di keterangan didahulukan; lalu gabungan semua dana sejenis di satu alur (Cak Ed + Jojo = 200rb)
  options.sort((a, b) => Number(b.kind === prefer) - Number(a.kind === prefer) || b.fundIds.length - a.fundIds.length || a.dates.length - b.dates.length);
  const best = options[0];
  const preferred = prefer ? options.filter((o) => o.kind === prefer) : [];
  const sure =
    !!input.toBankId &&
    (options.length === 1 ||
      preferred.length === 1 ||
      (best.fundIds.length > 1 && best.dates.length === 1 && !options.slice(1).some((o) => o.dates.length === 1 && o.kind === best.kind)));
  return { options: options.slice(0, 6).map(({ kind: _k, ...o }) => o), sure };
}

/** Baris jurnal tambahan untuk sisihan kompensasi owner: Dr Beban Kompensasi Pengelola / Cr Hutang Kompensasi Pengelola */
export async function reserveAccrualLines(db: Db, parts: ReservePart[]): Promise<LineInput[]> {
  if (!parts.length) return [];
  const funds = await db.reserveFund.findMany({ where: { id: { in: parts.map((p) => p.fundId) } } });
  const owner = parts.filter((p) => funds.find((f) => f.id === p.fundId)?.kind === "OWNER").reduce((t, p) => t + p.amount, 0);
  return owner > 0 ? [{ accountCode: COA.BEBAN_GAJI_OWNER, debit: owner, memo: "Kompensasi pengelola (sisihan)" }, { accountCode: COA.UTANG_GAJI_OWNER, credit: owner, memo: "Kompensasi pengelola (sisihan)" }] : [];
}

/** Rincian sisihan harus sesuai transaksi: nominal sama, dan alur dana = rekening asal → tujuan transfer */
export async function validateLink(db: Db, cur: { amount: bigint | number; accountId: string | null; toAccountId: string | null }, parts: ReservePart[]) {
  const funds = await db.reserveFund.findMany({ where: { id: { in: parts.map((p) => p.fundId) } } });
  for (const p of parts) {
    const f = funds.find((x) => x.id === p.fundId);
    if (!f) throw new Error("Dana sisihan tidak ditemukan");
    if (f.kind === "LOAN_PAYMENT") throw new Error(`${f.name} adalah cicilan harian (bukan transfer ke rekening simpanan)`);
    if (f.fromBankId !== cur.accountId || f.toBankId !== cur.toAccountId) throw new Error(`Rekening transfer tidak sesuai alur dana ${f.name}`);
  }
  const sum = parts.reduce((t, p) => t + p.amount, 0);
  if (sum !== Number(cur.amount)) throw new Error(`Total sisihan ${idr(sum)} ≠ nominal transfer ${idr(Number(cur.amount))}`);
}

/**
 * Catat sisihan dari transaksi yang baru dibukukan (jurnalnya = jurnal transaksi). Sisihan tanpa bukti yang sudah
 * dicatat lebih dulu (tombol Sisihkan) memakai transfer ini: jurnal lamanya dibalik agar uang tidak pindah dua kali.
 */
export async function applyReserveLink(
  tx: Prisma.TransactionClient,
  cur: { id: string; number: string; date: Date; proofPath: string | null; proofMime: string | null },
  parts: ReservePart[],
  journalId: string,
  actor: { id: string; name: string },
  now: Date = new Date(),
) {
  let created = 0;
  let absorbed = 0;
  for (const p of parts) {
    const old = await tx.reserveEntry.findFirst({ where: { fundId: p.fundId, date: dateOnly(p.date), type: "SISIH", transactionId: null, proofPath: null } });
    if (old) {
      if (old.journalId && old.journalId !== journalId && !(await tx.journal.findFirst({ where: { reversalOfId: old.journalId } }))) {
        const oj = await tx.journal.findUnique({ where: { id: old.journalId } });
        // Jurnal sisihan lama hanya untuk satu sisihan (dari tombol Sisihkan); dibalik bila bukan jurnal bersama
        const shared = await tx.reserveEntry.count({ where: { journalId: old.journalId, id: { not: old.id } } });
        if (oj && !shared) {
          const date = await assertPeriodOpen(tx, oj.date).then(() => oj.date, () => now);
          await reverseJournal(tx, oj.id, date, actor, `sisihan ${p.date} memakai transfer ${cur.number}`);
        }
      }
      await tx.reserveEntry.update({ where: { id: old.id }, data: { amount: BigInt(p.amount), journalId, transactionId: cur.id, proofPath: cur.proofPath, proofMime: cur.proofMime, note: old.note ?? `Transfer ${cur.number}` } });
      absorbed++;
    } else {
      await tx.reserveEntry.create({ data: { fundId: p.fundId, date: dateOnly(p.date), type: "SISIH", amount: BigInt(p.amount), journalId, transactionId: cur.id, proofPath: cur.proofPath, proofMime: cur.proofMime, note: `Transfer ${cur.number}`, createdBy: actor.name } });
      created++;
    }
  }
  return { created, absorbed };
}

/** Teks ringkas pilihan sisihan untuk ditampilkan */
export async function describeParts(db: Db, parts: ReservePart[]) {
  const funds = await db.reserveFund.findMany({ where: { id: { in: [...new Set(parts.map((p) => p.fundId))] } } });
  return funds.map((f) => {
    const mine = parts.filter((p) => p.fundId === f.id);
    return { fund: f, dates: mine.map((p) => p.date).sort(), amount: mine.reduce((t, p) => t + p.amount, 0) };
  });
}
