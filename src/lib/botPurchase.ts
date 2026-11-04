import { prisma } from "./db";
import { QTY_UNITS, suggestCategory, type ExtractCategory } from "./extract";
import { parseIDR } from "./money";

/**
 * Pesan/foto bukti pembelian bahan baku di bot Telegram: dikenali dari master bahan baku
 * (nama/kode barang tipe BAHAN_BAKU) lalu diarahkan ke isian Pembelian, bukan draft transaksi biasa.
 */
export type PurchaseItem = { id: string; sku: string; name: string; unit: string; supplierId: string | null };
export type PurchaseHit = { item: PurchaseItem; qty: number | null; others: PurchaseItem[] };

const BUY_WORDS = /\b(beli|membeli|pembelian|belanja|kulakan|order|restock|stok masuk)\b/;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const STOP = new Set(["bahan", "baku", "warna", "ukuran", "isi", "per", "dan", "untuk", "the"]);

/** Skor kecocokan nama barang dengan teks: 0 = tidak cocok; lebih besar = lebih spesifik */
function score(item: PurchaseItem, t: string): number {
  const words = ` ${t} `;
  const name = norm(item.name);
  if (name.length >= 3 && words.includes(` ${name} `)) return 100 + name.length;
  const sku = norm(item.sku);
  if (sku.length >= 3 && words.includes(` ${sku} `)) return 90 + sku.length;
  // Semua kata penting nama barang muncul di teks ("cat putih" cocok dengan "Cat Tembok Putih" bila kata utamanya ada)
  const key = name.split(" ").filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  if (!key.length) return 0;
  const hit = key.filter((w) => words.includes(` ${w} `));
  if (hit.length === key.length) return 50 + hit.join("").length;
  return 0;
}

/** Jumlah barang dari teks: "2000 pcs", "10 sak", "5 kg" */
export function extractQty(text: string): number | null {
  const m = text.toLowerCase().match(new RegExp(`\\b(\\d{1,3}(?:\\.\\d{3})+|\\d+(?:[.,]\\d+)?)\\s*(?:${QTY_UNITS})\\b`));
  if (!m) return null;
  const raw = /^\d{1,3}(\.\d{3})+$/.test(m[1]) ? m[1].replace(/\./g, "") : m[1].replace(",", ".");
  const n = Number(raw);
  return n > 0 ? n : null;
}

/**
 * Cocokkan teks (caption + nama penerima di bukti) dengan master bahan baku.
 * Wajib ada kata beli/pembelian/belanja, atau transaksi keluar yang menyebut bahan baku dengan jumlahnya.
 */
export function detectPurchase(text: string, items: PurchaseItem[], direction: string | null): PurchaseHit | null {
  const t = norm(text);
  if (!t) return null;
  const qty = extractQty(text);
  const buying = BUY_WORDS.test(text.toLowerCase());
  if (!buying && !(direction === "KELUAR" && qty)) return null;
  if (direction === "MASUK" || direction === "TRANSFER") return null;
  const ranked = items.map((item) => ({ item, s: score(item, t) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!ranked.length) return null;
  // Barang yang namanya bagian dari barang lain yang lebih spesifik tidak dihitung dua kali
  const picked: PurchaseItem[] = [];
  for (const { item } of ranked) if (!picked.some((p) => norm(p.name).includes(norm(item.name)))) picked.push(item);
  return { item: picked[0], qty, others: picked.slice(1, 5) };
}

export async function rawMaterials(): Promise<PurchaseItem[]> {
  return prisma.item.findMany({ where: { active: true, type: "BAHAN_BAKU" }, select: { id: true, sku: true, name: true, unit: true, supplierId: true } });
}

// ---------- Angsuran / pembayaran hutang supplier ----------
export type PayableCandidate = { id: string; number: string; vendor: string; remaining: number; purchaseNumber: string | null; items: string[]; kind?: string; installment?: number | null };
const PAY_WORDS = /\b(angsur|angsuran|ngangsur|cicil|cicilan|nyicil|pelunasan|lunasi|melunasi|hutang|utang|tempo|pinjaman|pinjam|spinjam|paylater|kredit)\b/;

/**
 * Pesan pembayaran hutang supplier / cicilan pinjaman ("angsur kardus", "bayar hutang <nama>", "cicilan <aplikasi>"):
 * cocokkan dengan hutang yang belum lunas lewat nama supplier/pemberi pinjaman, nama barang pembeliannya,
 * nomor pembelian/hutang, atau nominal yang sama persis dengan cicilan terjadwal.
 * `matches` kosong = kata angsuran ada tapi hutangnya tidak bisa dipastikan (pengguna memilih dari daftar).
 */
export function detectPayablePayment(text: string, payables: PayableCandidate[], direction: string | null, amount?: number | null): { matches: PayableCandidate[] } | null {
  if (direction === "MASUK" || direction === "TRANSFER") return null;
  if (!payables.length) return null;
  const low = text.toLowerCase();
  // Nominal persis sama dengan cicilan pinjaman terjadwal: cukup kuat walau tanpa kata "cicilan"
  const byAmount = amount ? payables.filter((p) => p.installment && Math.abs(p.installment - amount) <= 2) : [];
  if (!PAY_WORDS.test(low)) return byAmount.length ? { matches: byAmount } : null;
  const t = ` ${norm(text)} `;
  const has = (w: string) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w) && t.includes(` ${w} `);
  const ranked = payables
    .map((p) => {
      let s = 0;
      if (t.includes(` ${norm(p.number)} `) || (p.purchaseNumber && t.includes(` ${norm(p.purchaseNumber)} `))) s += 100;
      const vend = norm(p.vendor);
      if (vend.length >= 3 && t.includes(` ${vend} `)) s += 60;
      else if (vend.split(" ").filter((w) => w.length >= 4).some(has)) s += 30;
      // Makin banyak kata nama barang yang cocok, makin yakin ("kardus uji" > "uji")
      s += 20 * Math.max(0, ...p.items.map((n) => norm(n).split(" ").filter(has).length));
      if (amount && p.installment && Math.abs(p.installment - amount) <= 2) s += 50;
      else if (amount && amount === p.remaining) s += 10;
      return { p, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const top = ranked.length ? ranked.filter((x) => x.s === ranked[0].s).map((x) => x.p) : [];
  return { matches: top };
}

// ---------- Rincian: satu transfer untuk beberapa keperluan ----------
export type SplitGuess = { label: string; amount: number; categoryId: string | null; itemId: string | null; qty: number | null };

/** Barang master yang paling cocok dengan satu baris teks */
export function matchItem(text: string, items: PurchaseItem[]): PurchaseItem | null {
  const t = norm(text);
  return items.map((item) => ({ item, s: score(item, t) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0]?.item ?? null;
}

const LINE_AMOUNT = /^(.*?)[\s:=-]*\b(?:rp\.?\s*)?(\d[\d.,]*\s*(?:k|rb|ribu|jt|juta)?)\s*$/i;

/**
 * Pecah caption menjadi rincian, satu keperluan per baris: "beli dus bekas 5k / galon cleo 20k / ongkir gypsum 10k".
 * Minimal 2 baris bernominal. Baris yang menyebut bahan baku + jumlahnya ("kardus 50 pcs 100rb") menjadi stok masuk;
 * baris lain diberi kategori dari kata kuncinya (null = ditanyakan ke pengguna).
 */
export function extractSplits(text: string, categories: ExtractCategory[], items: PurchaseItem[], direction: string | null): SplitGuess[] {
  if (direction === "TRANSFER" || direction === "MASUK") return [];
  const rows = text.split(/\n|;|,(?!\d{3})/).map((x) => x.trim()).filter(Boolean);
  const out: SplitGuess[] = [];
  for (const row of rows) {
    const m = row.match(LINE_AMOUNT);
    if (!m) continue;
    const raw = m[2].replace(/\s+/g, "").toLowerCase();
    // Angka polos kecil tanpa satuan rupiah (mis. "2") bukan nominal; jumlah barang ("50 pcs") juga bukan
    if (!/[a-z]/.test(raw) && !/\d{1,3}(\.\d{3})+/.test(raw) && raw.replace(/\D/g, "").length < 4) continue;
    const amount = parseIDR(raw.replace(/k$/, "rb"));
    if (!amount || amount <= 0) continue;
    const label = m[1].replace(/^(beli|bayar|untuk|buat)\s+/i, "").trim() || row;
    const qty = extractQty(m[1]);
    const item = qty ? matchItem(m[1], items) : null;
    out.push({ label: label.slice(0, 80), amount, categoryId: suggestCategory(m[1], "KELUAR", categories), itemId: item?.id ?? null, qty: item ? qty : null });
  }
  return out.length >= 2 ? out : [];
}
