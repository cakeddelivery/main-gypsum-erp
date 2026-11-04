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
