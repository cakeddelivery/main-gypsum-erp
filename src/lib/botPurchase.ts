import { prisma } from "./db";
import { QTY_UNITS } from "./extract";

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

// ---------- Angsuran / pembayaran utang supplier ----------
export type PayableCandidate = { id: string; number: string; vendor: string; remaining: number; purchaseNumber: string | null; items: string[] };
const PAY_WORDS = /\b(angsur|angsuran|ngangsur|cicil|cicilan|nyicil|pelunasan|lunasi|melunasi|hutang|utang|tempo)\b/;

/**
 * Pesan pembayaran utang ke supplier ("angsur kardus", "bayar hutang Toko A"): cocokkan dengan utang yang belum lunas
 * lewat nama supplier, nama barang pembeliannya, atau nomor pembelian/utang.
 * `matches` kosong = kata angsuran ada tapi utangnya tidak bisa dipastikan (pengguna memilih dari daftar).
 */
export function detectPayablePayment(text: string, payables: PayableCandidate[], direction: string | null): { matches: PayableCandidate[] } | null {
  if (direction === "MASUK" || direction === "TRANSFER") return null;
  const low = text.toLowerCase();
  if (!PAY_WORDS.test(low) || !payables.length) return null;
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
      return { p, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const top = ranked.length ? ranked.filter((x) => x.s === ranked[0].s).map((x) => x.p) : [];
  return { matches: top };
}
