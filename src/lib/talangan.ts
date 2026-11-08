import { prisma } from "./db";
import { COA } from "./accounting";
import { approveAndBook, createTransaction, FinanceError, type Actor } from "./finance";
import { jakartaDateTime, todayStr } from "./time";

/**
 * Dana talangan: rekening simpanan dana sisihan (Seabank 0006 untuk tabungan cicilan, ShopeePay untuk kompensasi
 * owner) hanya dompet simpanan. Uang yang keluar dari sana untuk operasional (transaksi, pembelian, gaji, kasbon,
 * borongan) = talangan, dan wajib dikembalikan dari rekening operasional (Seabank 5984).
 * Bukan talangan: pengambilan kompensasi owner & bayar pinjaman lewat Dana sisihan, cicilan pinjaman yang dibayar
 * langsung dari rekening simpanan, transaksi berkategori kompensasi/prive owner, dan jurnal yang sudah dibatalkan.
 */
const SOURCES = ["FINANCE", "PEMBELIAN", "PAYROLL", "KASBON", "BORONGAN"];
const SOURCE_LABEL: Record<string, string> = { FINANCE: "Transaksi", PEMBELIAN: "Pembelian", PAYROLL: "Gaji", KASBON: "Kasbon", BORONGAN: "Borongan" };
export const DEFAULT_START = "2026-11-01";

export type TalanganItem = { journalId: string; date: Date; source: string; label: string; ref: string; description: string; amount: number; href: string | null };
export type TalanganWallet = {
  bank: { id: string; code: string; name: string; coaAccountId: string };
  fromBank: { id: string; name: string } | null;
  items: TalanganItem[];
  /** Belum dikembalikan (FIFO: pengembalian menutup talangan terlama dulu) */
  open: TalanganItem[];
  total: number;
  repaid: number;
  outstanding: number;
};

export async function talanganStart() {
  const s = await prisma.setting.findUnique({ where: { key: "talangan_mulai" } });
  return s?.value && /^\d{4}-\d{2}-\d{2}$/.test(s.value) ? s.value : DEFAULT_START;
}

/** Dompet simpanan = rekening tujuan dana sisihan aktif; dikembalikan dari rekening asal danannya */
export async function talanganWallets() {
  const funds = await prisma.reserveFund.findMany({ where: { active: true, kind: { in: ["OWNER", "LOAN_SAVING"] }, toBankId: { not: null } }, orderBy: { createdAt: "asc" } });
  const banks = await prisma.bankAccount.findMany();
  const out: { bank: (typeof banks)[number]; fromBank: (typeof banks)[number] | null }[] = [];
  for (const f of funds) {
    if (out.some((w) => w.bank.id === f.toBankId)) continue;
    const bank = banks.find((b) => b.id === f.toBankId);
    if (bank) out.push({ bank, fromBank: banks.find((b) => b.id === f.fromBankId) ?? null });
  }
  return out;
}

export async function talanganSummary(): Promise<TalanganWallet[]> {
  const start = jakartaDateTime(await talanganStart(), "00:00");
  const wallets = await talanganWallets();
  const ownerComp = await prisma.coaAccount.findMany({ where: { OR: [{ code: COA.UTANG_GAJI_OWNER }, { type: "EKUITAS" }] }, select: { id: true } });
  const out: TalanganWallet[] = [];
  for (const w of wallets) {
    const lines = await prisma.journalLine.findMany({
      where: { accountId: w.bank.coaAccountId, credit: { gt: 0 }, journal: { date: { gte: start }, source: { in: SOURCES }, reversalOfId: null } },
      include: { journal: true },
      orderBy: { journal: { date: "asc" } },
    });
    const reversed = new Set((await prisma.journal.findMany({ where: { reversalOfId: { in: lines.map((l) => l.journalId) } }, select: { reversalOfId: true } })).map((j) => j.reversalOfId!));
    const txIds = lines.filter((l) => l.journal.source === "FINANCE" && l.journal.sourceId).map((l) => l.journal.sourceId!);
    const txs = await prisma.financeTransaction.findMany({ where: { id: { in: txIds } }, include: { payable: { select: { kind: true } }, splits: { select: { categoryId: true } } } });
    const cats = await prisma.txCategory.findMany({ where: { coaAccountId: { in: ownerComp.map((a) => a.id) } }, select: { id: true } });
    const ownerCat = new Set(cats.map((c) => c.id));
    const items: TalanganItem[] = [];
    for (const l of lines) {
      if (reversed.has(l.journalId)) continue;
      const j = l.journal;
      let ref = j.number;
      let href: string | null = null;
      let description = j.description;
      if (j.source === "FINANCE") {
        const t = txs.find((x) => x.id === j.sourceId);
        if (t) {
          // Cicilan pinjaman dari tabungan cicilan & pengambilan kompensasi/prive owner = memang kegunaan dompet ini
          if (t.payable?.kind === "PINJAMAN") continue;
          if (t.categoryId && ownerCat.has(t.categoryId) && !t.splits.length) continue;
          if (t.bailoutRepay) continue;
          ref = t.number;
          href = `/finance/${t.id}`;
          description = t.note ?? t.counterparty ?? j.description;
        }
      } else if (j.source === "PEMBELIAN") {
        ref = j.sourceId ?? j.number;
        href = "/stok/pembelian";
      } else if (j.source === "PAYROLL" || j.source === "KASBON") href = "/gaji";
      else if (j.source === "BORONGAN") href = "/borongan";
      items.push({ journalId: j.id, date: j.date, source: j.source, label: SOURCE_LABEL[j.source] ?? j.source, ref, description, amount: Number(l.credit) - Number(l.debit), href });
    }
    const repays = await prisma.financeTransaction.aggregate({ where: { bailoutRepay: true, status: "DIBUKUKAN", toAccountId: w.bank.id, date: { gte: start } }, _sum: { amount: true } });
    const repaid = Number(repays._sum.amount ?? 0);
    const total = items.reduce((t, i) => t + i.amount, 0);
    let left = repaid;
    const open: TalanganItem[] = [];
    for (const i of items) {
      if (left >= i.amount) {
        left -= i.amount;
        continue;
      }
      open.push(left > 0 ? { ...i, amount: i.amount - left } : i);
      left = 0;
    }
    out.push({ bank: w.bank, fromBank: w.fromBank, items, open, total, repaid, outstanding: Math.max(0, total - repaid) });
  }
  return out;
}

/** Total talangan belum dikembalikan semua dompet */
export async function talanganOutstanding() {
  const s = await talanganSummary();
  return { total: s.reduce((t, w) => t + w.outstanding, 0), count: s.reduce((t, w) => t + w.open.length, 0), wallets: s };
}

const idr = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;

/** Teks pengingat (Telegram/HTML) berisi rincian talangan per dompet; null bila tidak ada */
export function talanganReminderText(wallets: TalanganWallet[], esc: (s: string) => string) {
  const open = wallets.filter((w) => w.outstanding > 0);
  if (!open.length) return null;
  const fmt = (d: Date) => d.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short" });
  const parts = open.map((w) => {
    const rows = w.open.slice(0, 15).map((i) => `• ${fmt(i.date)} · ${esc(i.label)} ${esc(i.ref)} · ${esc(i.description.slice(0, 40))} · ${idr(i.amount)}`);
    const more = w.open.length > 15 ? `\n… dan ${w.open.length - 15} lainnya` : "";
    return `<b>${esc(w.bank.name)}</b>: ${idr(w.outstanding)}\n${rows.join("\n")}${more}\nKembalikan dari ${esc(w.fromBank?.name ?? "rekening operasional")} → ${esc(w.bank.name)} sebesar <b>${idr(w.outstanding)}</b>`;
  });
  const total = open.reduce((t, w) => t + w.outstanding, 0);
  return `⚠️ <b>Dana talangan belum dikembalikan: ${idr(total)}</b>\nRekening simpanan dana sisihan dipakai untuk operasional:\n\n${parts.join("\n\n")}`;
}

/**
 * Catat pengembalian dana talangan: transfer rekening operasional → dompet simpanan (dengan bukti), langsung
 * dibukukan, bukan sisihan. Nominal tidak boleh melebihi talangan yang belum dikembalikan.
 */
export async function repayTalangan(
  input: { walletId: string; amount: number; date: string; time?: string; fromBankId?: string | null; proofPath?: string | null; proofMime?: string | null; idempotencyKey?: string | null; telegramChatId?: string | null; telegramMessageId?: string | null },
  source: "MANUAL" | "TELEGRAM",
  actor: Actor & { id: string },
) {
  const s = (await talanganSummary()).find((w) => w.bank.id === input.walletId);
  if (!s) throw new FinanceError("Rekening ini bukan dompet simpanan dana sisihan");
  if (!(input.amount > 0)) throw new FinanceError("Nominal harus > 0");
  if (input.amount > s.outstanding) throw new FinanceError(`Nominal melebihi talangan yang belum dikembalikan (${idr(s.outstanding)})`);
  const fromBankId = input.fromBankId ?? s.fromBank?.id;
  if (!fromBankId) throw new FinanceError("Pilih rekening asal pengembalian");
  if (fromBankId === s.bank.id) throw new FinanceError("Rekening asal dan tujuan harus berbeda");
  const refs = s.open.map((i) => i.ref).slice(0, 12).join(", ");
  const r = await createTransaction(
    {
      direction: "TRANSFER",
      amount: input.amount,
      date: jakartaDateTime(input.date, input.time ?? (input.date === todayStr() ? new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" }) : "12:00")),
      accountId: fromBankId,
      toAccountId: s.bank.id,
      note: `Pengembalian dana talangan ${s.bank.name}${refs ? ` (${refs})` : ""}`.slice(0, 500),
      counterparty: s.bank.name,
      proofPath: input.proofPath ?? null,
      proofMime: input.proofMime ?? null,
      reserveLink: { skip: true },
      bailoutRepay: true,
      idempotencyKey: input.idempotencyKey ?? null,
      telegramChatId: input.telegramChatId ?? null,
      telegramMessageId: input.telegramMessageId ?? null,
    },
    source,
    actor,
    { submit: true },
  );
  if (r.replayed) return { transaction: r.transaction, booked: r.transaction.status === "DIBUKUKAN", remaining: s.outstanding };
  if (r.transaction.status !== "MENUNGGU_KONFIRMASI") return { transaction: r.transaction, booked: false, remaining: s.outstanding };
  const b = await approveAndBook(r.transaction.id, actor, "Pengembalian dana talangan");
  return { transaction: b.transaction, booked: true, remaining: s.outstanding - input.amount };
}

/** Nominal di foto bukti transfer (AI, lalu OCR server); null bila tidak terbaca. Dibatasi waktu agar form tidak menggantung */
export async function readProofAmount(image: Buffer, mime: string): Promise<number | null> {
  if (!mime.startsWith("image/")) return null;
  const banks = await prisma.bankAccount.findMany({ where: { active: true } });
  const limit = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]).catch(() => null);
  const { readReceipt } = await import("./receipt");
  const ai = await limit(readReceipt(image, "bukti transfer pengembalian dana talangan", banks, mime), 25_000);
  if (ai?.amount) return ai.amount;
  const { ocrReceipt } = await import("./ocrReceipt");
  const ocr = await limit(ocrReceipt(image, banks), 20_000);
  return ocr?.amount ?? null;
}
