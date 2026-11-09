import { parseIDR } from "./money";
import { addDays, todayStr } from "./time";

export type ExtractAccount = { id: string; code: string; name: string; aliases: string; marketplace?: boolean };

/**
 * Saldo penjual marketplace tidak bisa menerima transfer dari bank. Transfer bank → "Saldo Penjual Shopee" hampir
 * pasti ke dompet digital platform yang sama (ShopeePay); kembalikan rekening pengganti, atau null bila tidak perlu.
 */
export function walletForMarketplace<T extends { id: string; code: string; name: string; marketplace?: boolean; active?: boolean }>(target: T, banks: T[]): T | null {
  if (!target.marketplace) return null;
  const key = `${target.code} ${target.name}`;
  const platform = /tik\s?tok/i.test(key) ? "tiktok" : /shopee/i.test(key) ? "shopee" : null;
  if (!platform) return null;
  return banks.find((b) => !b.marketplace && b.active !== false && `${b.code} ${b.name}`.toLowerCase().replace(/\s/g, "").includes(platform)) ?? null;
}

/** Rekening tujuan transfer dibetulkan bila bank → saldo penjual (lihat walletForMarketplace) */
export function fixTransferTarget(fromId: string | null, toId: string | null, accounts: ExtractAccount[]): string | null {
  if (!toId) return toId;
  const from = accounts.find((a) => a.id === fromId);
  const to = accounts.find((a) => a.id === toId);
  if (!to || (from && from.marketplace)) return toId;
  return walletForMarketplace(to, accounts)?.id ?? toId;
}
export type ExtractCategory = { id: string; name: string; direction: "MASUK" | "KELUAR" | "TRANSFER"; keywords: string };

export type Extraction = {
  amount: number | null;
  date: string | null;
  /** Jam WIB "HH:MM" bila tertulis di pesan/bukti */
  time?: string | null;
  direction: "MASUK" | "KELUAR" | "TRANSFER" | null;
  accountId: string | null;
  toAccountId: string | null;
  /** Hutang supplier / pinjaman yang dibayar (dari nama supplier / kata "angsur", "cicilan") */
  payableId?: string | null;
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

/**
 * Jam "HH:MM" dari teks: "jam 14.30", "pukul 9", "14:30 WIB", "03 Nov 2026 14:30:12".
 * Angka berpemisah titik tanpa kata jam/pukul/WIB tidak dianggap jam (bisa nominal "10.000").
 */
export function extractTime(text: string): string | null {
  const t = text.toLowerCase();
  const ok = (h: number, m: number) => (h >= 0 && h <= 23 && m >= 0 && m <= 59 ? `${pad(h)}:${pad(m)}` : null);
  let m = t.match(/\b(?:jam|pukul|pkl)\.?\s*(\d{1,2})(?:[.:](\d{2}))?\b/);
  if (m) return ok(+m[1], m[2] ? +m[2] : 0);
  m = t.match(/(?<![\d.,:])(\d{1,2})[.:](\d{2})(?:[.:]\d{2})?\s*(?:wib|wita|wit)\b/);
  if (m) return ok(+m[1], +m[2]);
  m = t.match(/(?<![\d.,:])(\d{1,2}):(\d{2})(?::\d{2})?(?![\d.,:])/);
  if (m) return ok(+m[1], +m[2]);
  return null;
}

/** Satuan jumlah barang: angka di depannya adalah kuantitas, bukan nominal ("2000 pcs", "10 sak") */
export const QTY_UNITS = "pcs|pc|biji|buah|bh|sak|zak|kg|kilo|kilogram|gram|gr|ons|lembar|lbr|dus|box|karton|roll|rol|meter|mtr|liter|ltr|pack|pak|bal|ikat|unit|botol|kaleng|galon|ton|set|lusin|kodi|rim|batang|btg|keping|kpg";

/** Buang tanggal, jam & kuantitas barang dari teks agar angkanya tidak terbaca sebagai nominal */
function stripNonAmounts(t: string) {
  return t
    .replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{1,2}\s+(?:jan|feb|mar|apr|mei|may|jun|jul|agu|agt|aug|sep|okt|oct|nov|des|dec)[a-z]*\.?(?:\s*\d{4})?\b/g, " ")
    .replace(/\b(?:jam|pukul|pkl)\.?\s*\d{1,2}(?:[.:]\d{2})?\b/g, " ")
    .replace(/(?<![\d.,])\d{1,2}[.:]\d{2}(?:[.:]\d{2})?\s*(?:wib|wita|wit)\b/g, " ")
    .replace(/(?<![\d.,:])\d{1,2}:\d{2}(?::\d{2})?(?![\d.,:])/g, " ")
    .replace(new RegExp(`\\b\\d[\\d.,]*\\s*(?:${QTY_UNITS})\\b`, "g"), " ")
    .replace(/\b(?:tahun|thn|th)\.?\s*\d{4}\b/g, " ");
}

const EXPLICIT_AMOUNT = [/rp\.?\s*([\d.,]+(?:\s*(?:jt|juta|rb|ribu|k))?)/, /\b([\d.,]+\s*(?:jt|juta|rb|ribu|k))\b/, /(?:nominal|total|sebesar|jumlah|harga)\s*:?\s*(?:rp\.?\s*)?([\d.,]+)/];

/**
 * Nominal dari teks. Tanggal, tahun, jam, dan jumlah barang ("2000 pcs") diabaikan.
 * Angka polos tanpa Rp/rb/jt hanya dianggap nominal bila berpemisah ribuan (10.000) atau minimal 5 digit.
 */
export function extractAmount(text: string): number | null {
  const t = stripNonAmounts(text.toLowerCase());
  for (const p of [...EXPLICIT_AMOUNT, /\b(\d{1,3}(?:\.\d{3})+)\b/, /\b(\d{5,})\b/]) {
    const m = t.match(p);
    if (m) {
      const v = parseIDR(m[1].replace(/\s+/g, ""));
      if (v && v > 0) return v;
    }
  }
  return null;
}

/** Nominal ditulis jelas (Rp, rb, jt, "nominal ..."): lebih diutamakan daripada hasil baca foto bukti */
export function hasExplicitAmount(text: string): boolean {
  const t = stripNonAmounts(text.toLowerCase());
  return EXPLICIT_AMOUNT.some((p) => {
    const m = t.match(p);
    return !!m && (parseIDR(m[1].replace(/\s+/g, "")) ?? 0) > 0;
  });
}

/** Kata kunci muncul sebagai kata utuh: "saldo shopee" tidak boleh cocok dengan "saldo shopeepay" */
function hasKey(s: string, k: string) {
  for (let i = s.indexOf(k); i >= 0; i = s.indexOf(k, i + 1)) {
    const before = i === 0 ? "" : s[i - 1];
    const after = s[i + k.length] ?? "";
    if (!/[a-z]/.test(before) && !/[a-z]/.test(after)) return true;
  }
  return false;
}

export function matchAccount(segment: string, accounts: ExtractAccount[]): string | null {
  const s = segment.toLowerCase();
  let best: { id: string; len: number } | null = null;
  for (const a of accounts) {
    const keys = [a.name, a.code, ...a.aliases.split(",")].map((k) => k.trim().toLowerCase()).filter(Boolean);
    for (const k of keys) {
      if (hasKey(s, k) && (!best || k.length > best.len)) best = { id: a.id, len: k.length };
    }
  }
  return best?.id ?? null;
}

// ---------- Pinjaman pengelola ----------
/** Nama/panggilan pengelola yang dikenali di pesan (bisa ditambah lewat setting pengelola_nama, dipisah koma) */
export const DEFAULT_MANAGER_NAMES = ["pengelola", "owner", "cak ed", "mas edy", "edy", "jojo", "mas jojo"];
const LOAN_VERB = /\b(pinjam|dipinjam|minjam|meminjam|pinjem|dipinjem|minjem|ngutang)\b/;
const RETURN_VERB = /\b(kembali|kembalikan|dikembalikan|mengembalikan|balikin|dibalikin|pengembalian|nyaur|melunasi|lunasi)\b/;

/**
 * Pesan pinjaman uang usaha oleh pengelola ("Edy pinjam dana OPS untuk pribadi", "jojo kembalikan pinjaman"):
 * PINJAM = uang keluar (Piutang Pengelola), KEMBALI = uang masuk pengembalian. null bila bukan.
 * Hanya kata kerja pinjam (bukan kata benda "pinjaman" cicilan SPinjam dsb.) + nama pengelola.
 */
export function detectManagerLoan(text: string, names: string[] = DEFAULT_MANAGER_NAMES): "PINJAM" | "KEMBALI" | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const who = names.map((n) => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).filter((n) => n.length >= 2).some((n) => t.includes(` ${n} `));
  if (!who) return null;
  const ret = RETURN_VERB.test(t);
  if (LOAN_VERB.test(t)) return ret ? "KEMBALI" : "PINJAM";
  // "jojo kembalikan pinjaman 500rb": kata benda pinjaman + kata kembali
  if (ret && /\bpinjaman\b/.test(t)) return "KEMBALI";
  return null;
}

/**
 * Toko dari inisial/nama: "WD MG shopee", "withdraw dunia lukis" → kode toko (MG / DL).
 * Hanya kode toko sebagai kata utuh, atau nama tokonya.
 */
export function matchStore(text: string, stores: { id: string; code: string; name: string }[]): string | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (const st of stores) {
    const name = st.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (t.includes(` ${st.code.toLowerCase()} `) || (name && t.includes(` ${name} `))) return st.id;
  }
  return null;
}

/** Saldo penjual marketplace yang disebut di pesan withdraw ("wd shopee", "withdraw tiktok") */
function marketplaceAccount(t: string, accounts: ExtractAccount[]): string | null {
  const platform = /\btik\s?tok\b/.test(t) ? "tiktok" : /\bshopee\b(?!\s*pay)/.test(t) ? "shopee" : null;
  if (!platform) return null;
  return accounts.find((a) => /saldo|penjual|seller/i.test(`${a.code} ${a.name}`) && `${a.code} ${a.name}`.toLowerCase().replace(/\s/g, "").includes(platform))?.id ?? null;
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
  else if (/\b(keluar|bayar|beli|pembelian|biaya|pengeluaran|belanja|ongkir|gaji|upah|isi ulang|refill|servis|service|sewa|tagihan|angsur|angsuran|cicil|cicilan|nyicil|kulakan|hutang|utang|pelunasan)\b/.test(t)) direction = "KELUAR";
  // "transfer/sisihkan dari seabank ke shopeepay": dua rekening sendiri = transfer internal
  if (direction !== "TRANSFER" && direction !== "MASUK") {
    const m = t.match(/dari\s+([a-z0-9 ]+?)\s+ke\s+([a-z0-9 ]+?)(?:\s+(?:rp|sebesar|\d)|$)/);
    const a = m ? matchAccount(m[1], accounts) : null;
    const b = m ? matchAccount(m[2], accounts) : null;
    if (a && b && a !== b && (direction === null || /\b(transfer|tf|pindah|sisih|sisihkan|nabung|menabung|tabungan|setor)\b/.test(t))) direction = "TRANSFER";
  }

  let accountId: string | null = null;
  let toAccountId: string | null = null;
  if (direction === "TRANSFER") {
    const from = t.match(/dari\s+([a-z0-9 ]+?)(?:\s+ke\s+|$)/);
    const to = t.match(/ke\s+([a-z0-9 ]+?)(?:\s+(?:rp|sebesar|\d)|$)/);
    accountId = from ? matchAccount(from[1], accounts) : null;
    toAccountId = to ? matchAccount(to[1], accounts) : null;
    // "WD MG shopee 500rb": withdraw tanpa kata "dari" = dari saldo penjual platform yang disebut
    if (!accountId && /\b(wd|withdraw|penarikan|tarik saldo|tarik dana)\b/.test(t)) accountId = marketplaceAccount(t, accounts);
    toAccountId = fixTransferTarget(accountId, toAccountId, accounts);
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

  return { amount, date: date ?? todayStr(now), time: extractTime(text), direction, accountId, toAccountId, categoryId, note: text.trim().slice(0, 500), confidence, missing };
}

export type ReceiptHint = { amount: number | null; date: string | null; time?: string | null; direction: "MASUK" | "KELUAR" | "TRANSFER" | null; account: string | null; toAccount?: string | null; counterparty: string | null };

/**
 * Gabungkan hasil baca foto bukti dengan caption. Nominal/tanggal/rekening yang ditulis di caption
 * tetap diutamakan; caption tanpa angka (hanya keterangan) dilengkapi dari foto.
 */
export function mergeReceipt(ex: Extraction, text: string, rx: ReceiptHint | null, accounts: ExtractAccount[], categories: ExtractCategory[], now: Date = new Date()): Extraction {
  if (!rx) return ex;
  const direction = ex.direction ?? rx.direction;
  // Foto bukti transfer: nominal di bukti dipakai, kecuali caption menulis nominal dengan jelas (Rp/rb/jt)
  const amount = hasExplicitAmount(text) ? ex.amount ?? rx.amount : rx.amount ?? ex.amount;
  const captionDate = extractDate(text, now);
  const date = captionDate ?? rx.date ?? ex.date;
  // Jam: yang ditulis di caption diutamakan, lalu jam di bukti (hanya bila tanggalnya juga dari bukti/sama)
  const time = extractTime(text) ?? (rx.time && (!captionDate || captionDate === rx.date) ? rx.time : null);
  const fromRx = rx.account ? matchAccount(rx.account, accounts) : null;
  const toRx = rx.toAccount ? matchAccount(rx.toAccount, accounts) : null;
  // Transfer internal: rekening asal/tujuan dari foto lebih tepat daripada kata acak di caption
  const transferFromPhoto = direction === "TRANSFER" && ex.direction !== "TRANSFER";
  const accountId = transferFromPhoto ? fromRx ?? ex.accountId : ex.accountId ?? fromRx;
  const toAccountId = direction === "TRANSFER" ? fixTransferTarget(accountId, ex.toAccountId ?? toRx, accounts) : null;
  const basis = [text, rx.counterparty].filter(Boolean).join(" ");
  const categoryId = direction === "TRANSFER" ? null : ex.direction === direction && ex.categoryId ? ex.categoryId : suggestCategory(basis, direction, categories);
  const missing: string[] = [];
  if (!amount) missing.push("nominal");
  if (!direction) missing.push("jenis transaksi");
  if (!accountId) missing.push("rekening");
  if (direction === "TRANSFER" && !toAccountId) missing.push("rekening tujuan");
  if (direction !== "TRANSFER" && !categoryId) missing.push("kategori");
  const note = [text.trim(), rx.counterparty && !text.toLowerCase().includes(rx.counterparty.toLowerCase()) ? `(${rx.counterparty})` : ""].filter(Boolean).join(" ").slice(0, 500);
  return { ...ex, amount, date, time, direction, accountId, toAccountId, categoryId, note, confidence: Math.round(((5 - missing.length) / 5) * 100) / 100, missing };
}
