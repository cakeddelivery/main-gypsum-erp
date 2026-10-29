import { parseIDR } from "./money";
import { addDays, todayStr } from "./time";

export type ExtractAccount = { id: string; code: string; name: string; aliases: string };
export type ExtractCategory = { id: string; name: string; direction: "MASUK" | "KELUAR" | "TRANSFER"; keywords: string };

export type Extraction = {
  amount: number | null;
  date: string | null;
  direction: "MASUK" | "KELUAR" | "TRANSFER" | null;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  note: string;
  confidence: number;
  missing: string[];
};

const MONTHS: Record<string, number> = {
  jan: 1, januari: 1, feb: 2, februari: 2, mar: 3, maret: 3, apr: 4, april: 4, mei: 5, jun: 6, juni: 6,
  jul: 7, juli: 7, agu: 8, agt: 8, agustus: 8, ags: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, oct: 10,
  nov: 11, november: 11, des: 12, desember: 12, dec: 12,
};

function pad(x: number) {
  return String(x).padStart(2, "0");
}

export function extractDate(text: string, now: Date = new Date()): string | null {
  const t = text.toLowerCase();
  const today = todayStr(now);
  if (/\bhari ini\b/.test(t)) return today;
  if (/\bkemarin\b/.test(t)) return addDays(today, -1);
  let m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m) {
    const d = +m[1], mo = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/\b(\d{1,2})\s+([a-z]{3,9})\.?\s*(\d{4})?\b/);
  if (m && MONTHS[m[2]]) {
    const y = m[3] ? +m[3] : +today.slice(0, 4);
    return `${y}-${pad(MONTHS[m[2]])}-${pad(+m[1])}`;
  }
  return null;
}

export function extractAmount(text: string): number | null {
  const t = text.toLowerCase();
  const patterns = [
    /rp\.?\s*([\d.,]+(?:\s*(?:jt|juta|rb|ribu|k))?)/,
    /\b([\d.,]+\s*(?:jt|juta|rb|ribu|k))\b/,
    /(?:nominal|total|sebesar|jumlah)\s*:?\s*([\d.,]+)/,
    /\b(\d{1,3}(?:\.\d{3})+)\b/,
    /\b(\d{4,})\b/,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) {
      const v = parseIDR(m[1].replace(/\s+/g, ""));
      if (v && v > 0) return v;
    }
  }
  return null;
}

function matchAccount(segment: string, accounts: ExtractAccount[]): string | null {
  const s = segment.toLowerCase();
  let best: { id: string; len: number } | null = null;
  for (const a of accounts) {
    const keys = [a.name, a.code, ...a.aliases.split(",")].map((k) => k.trim().toLowerCase()).filter(Boolean);
    for (const k of keys) {
      if (s.includes(k) && (!best || k.length > best.len)) best = { id: a.id, len: k.length };
    }
  }
  return best?.id ?? null;
}

/** Rekomendasi kategori berbasis kata kunci; mengembalikan id kategori dengan skor tertinggi */
// Nama usaha/toko sering ikut ditulis di keterangan dan tidak boleh memicu kata kunci kategori (mis. "gypsum")
const BUSINESS_NAMES = /\b(main\s*gypsum|dunia\s*lukis)\b/g;

export function suggestCategory(text: string, direction: string | null, categories: ExtractCategory[]): string | null {
  const t = text.toLowerCase().replace(BUSINESS_NAMES, " ");
  let best: { id: string; score: number } | null = null;
  for (const c of categories) {
    if (direction && c.direction !== direction) continue;
    const kws = [c.name, ...c.keywords.split(",")].map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 3);
    let score = 0;
    for (const k of kws) if (t.includes(k)) score += k.length;
    if (score > 0 && (!best || score > best.score)) best = { id: c.id, score };
  }
  return best?.id ?? null;
}

/** Ekstraksi aturan (fallback lokal) untuk pesan teks admin. Hasilnya selalu draft, bukan jurnal. */
export function extractTransaction(text: string, accounts: ExtractAccount[], categories: ExtractCategory[], now: Date = new Date()): Extraction {
  const t = text.toLowerCase();
  let direction: Extraction["direction"] = null;
  if (/\b(transfer internal|pindah dana|pindah saldo|tarik saldo|tarik dana|pindahkan|withdraw|wd|penarikan)\b/.test(t)) direction = "TRANSFER";
  else if (/\b(masuk|terima|diterima|pemasukan|pendapatan|penjualan|cair|pencairan|dp dari)\b/.test(t)) direction = "MASUK";
  else if (/\b(keluar|bayar|beli|pembelian|biaya|pengeluaran|belanja|ongkir|gaji|upah)\b/.test(t)) direction = "KELUAR";

  let accountId: string | null = null;
  let toAccountId: string | null = null;
  if (direction === "TRANSFER") {
    const from = t.match(/dari\s+([a-z0-9 ]+?)(?:\s+ke\s+|$)/);
    const to = t.match(/ke\s+([a-z0-9 ]+?)(?:\s+(?:rp|sebesar|\d)|$)/);
    accountId = from ? matchAccount(from[1], accounts) : null;
    toAccountId = to ? matchAccount(to[1], accounts) : null;
  } else {
    accountId = matchAccount(t, accounts);
  }

  const amount = extractAmount(text);
  const date = extractDate(text, now);
  const categoryId = direction === "TRANSFER" ? null : suggestCategory(text, direction, categories);

  const missing: string[] = [];
  if (!amount) missing.push("nominal");
  if (!direction) missing.push("jenis transaksi");
  if (!accountId) missing.push("rekening");
  if (direction === "TRANSFER" && !toAccountId) missing.push("rekening tujuan");
  if (direction !== "TRANSFER" && !categoryId) missing.push("kategori");
  const fields = direction === "TRANSFER" ? 5 : 5;
  const confidence = Math.round(((fields - missing.length) / fields) * 100) / 100;

  return { amount, date: date ?? todayStr(now), direction, accountId, toAccountId, categoryId, note: text.trim().slice(0, 500), confidence, missing };
}

export type ReceiptHint = { amount: number | null; date: string | null; direction: "MASUK" | "KELUAR" | "TRANSFER" | null; account: string | null; toAccount?: string | null; counterparty: string | null };

/**
 * Gabungkan hasil baca foto bukti dengan caption. Nominal/tanggal/rekening yang ditulis di caption
 * tetap diutamakan; caption tanpa angka (hanya keterangan) dilengkapi dari foto.
 */
export function mergeReceipt(ex: Extraction, text: string, rx: ReceiptHint | null, accounts: ExtractAccount[], categories: ExtractCategory[], now: Date = new Date()): Extraction {
  if (!rx) return ex;
  const direction = ex.direction ?? rx.direction;
  const amount = ex.amount ?? rx.amount;
  const date = extractDate(text, now) ?? rx.date ?? ex.date;
  const fromRx = rx.account ? matchAccount(rx.account, accounts) : null;
  const toRx = rx.toAccount ? matchAccount(rx.toAccount, accounts) : null;
  // Transfer internal: rekening asal/tujuan dari foto lebih tepat daripada kata acak di caption
  const transferFromPhoto = direction === "TRANSFER" && ex.direction !== "TRANSFER";
  const accountId = transferFromPhoto ? fromRx ?? ex.accountId : ex.accountId ?? fromRx;
  const toAccountId = direction === "TRANSFER" ? ex.toAccountId ?? toRx : null;
  const basis = [text, rx.counterparty].filter(Boolean).join(" ");
  const categoryId = direction === "TRANSFER" ? null : ex.direction === direction && ex.categoryId ? ex.categoryId : suggestCategory(basis, direction, categories);
  const missing: string[] = [];
  if (!amount) missing.push("nominal");
  if (!direction) missing.push("jenis transaksi");
  if (!accountId) missing.push("rekening");
  if (direction === "TRANSFER" && !toAccountId) missing.push("rekening tujuan");
  if (direction !== "TRANSFER" && !categoryId) missing.push("kategori");
  const note = [text.trim(), rx.counterparty && !text.toLowerCase().includes(rx.counterparty.toLowerCase()) ? `(${rx.counterparty})` : ""].filter(Boolean).join(" ").slice(0, 500);
  return { ...ex, amount, date, direction, accountId, toAccountId, categoryId, note, confidence: Math.round(((5 - missing.length) / 5) * 100) / 100, missing };
}
