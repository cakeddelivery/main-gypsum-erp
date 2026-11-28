import { prisma } from "./db";
import { reserveIntent } from "./reserveSync";
import { PAY_WORDS } from "./botGaji";
import { BUY_WORDS, detectPayablePayment, detectPurchase, extractQty, isExpenseText, rawMaterials, type PayableCandidate, type PurchaseItem } from "./botPurchase";
import { openPayables } from "./payables";
import { supplierKey, supplierNames } from "./suppliers";
import { DEFAULT_MANAGER_NAMES } from "./extract";

/**
 * Pengenalan jenis pesan bebas di bot (tanpa menu): aturan kata kunci + pencocokan master data
 * (barang nama/SKU, supplier & nama lain, karyawan/pengelola, utang terbuka). Tidak memakai LLM / dependensi baru.
 * Hasil = kandidat jenis berskor; ragu (skor rendah / dua jenis mungkin) → bot menampilkan pilihan jenis, bukan menebak.
 */
export type IntakeKind = "PEMBELIAN" | "BAYAR_HUTANG" | "GAJI" | "KOMPENSASI" | "BEBAN" | "PENJUALAN";
export const KIND_LABEL: Record<IntakeKind, string> = {
  PEMBELIAN: "🛒 Pembelian bahan/barang",
  BAYAR_HUTANG: "💳 Bayar hutang supplier / cicilan",
  GAJI: "💵 Gaji / upah",
  KOMPENSASI: "🧑‍💼 Kompensasi / sisihan pengelola",
  BEBAN: "🧾 Beban (LPG, konsumsi, ongkir, dll.)",
  PENJUALAN: "💰 Penjualan / pemasukan",
};
export const KIND_DIRECTION: Record<IntakeKind, "MASUK" | "KELUAR" | "TRANSFER"> = { PEMBELIAN: "KELUAR", BAYAR_HUTANG: "KELUAR", GAJI: "KELUAR", KOMPENSASI: "TRANSFER", BEBAN: "KELUAR", PENJUALAN: "MASUK" };

export type ClassifyContext = {
  items: PurchaseItem[];
  payables: PayableCandidate[];
  suppliers: { id: string; name: string; aliases: string }[];
  employees: string[];
  managers: string[];
};
export type Candidate = { kind: IntakeKind; score: number; why: string[]; /** Gaji borongan (upah titik), bukan slip karyawan */ borongan?: boolean };
export type Classification = { ranked: Candidate[]; top: Candidate | null; ambiguous: boolean };

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const DEBT_WORDS = /\b(angsur|angsuran|ngangsur|cicil|cicilan|nyicil|pelunasan|lunasi|melunasi|hutang|utang|tempo)\b/i;
const GAJI_WORDS = /\b(gaji|gajian|upah|bayaran|slip|lembur|honor|thr|bonus)\b/i;
const BEBAN_EXTRA = /\b(listrik|pln|air pdam|pdam|wifi|internet|pulsa|servis|service|perbaikan|atk|alat tulis|pajak|retribusi|iuran|sewa|admin bank|biaya admin)\b/i;
const SALE_WORDS = /\b(jual|terjual|penjualan|pembeli|customer|pelanggan|pesanan|orderan|dp dari|pembayaran dari|transfer masuk|pemasukan|pendapatan|cair|pencairan)\b/i;
const COMP_WORDS = /\b(kompensasi|komp|ops|jatah)\b/i;
const MIN_OK = 45;

const cap = (n: number) => Math.min(100, n);

export function classifyIntake(text: string, hint: { direction: "MASUK" | "KELUAR" | "TRANSFER" | null; amount: number | null }, ctx: ClassifyContext): Classification {
  const t = norm(text);
  const cands: Candidate[] = [];
  const add = (kind: IntakeKind, score: number, why: string[], extra: Partial<Candidate> = {}) => { if (score >= 20) cands.push({ kind, score: cap(score), why, ...extra }); };
  const supplierHit = ctx.suppliers.some((s) => supplierNames(s).map(supplierKey).some((n) => n.length >= 4 && t.includes(` ${n} `)));
  const qty = extractQty(text);

  // BEBAN: LPG/konsumsi/ongkir/listrik/dll. (menang atas kata "beli")
  if (isExpenseText(text) || BEBAN_EXTRA.test(text)) add("BEBAN", 60 + (hint.direction === "KELUAR" || hint.direction === null ? 10 : 0), ["kata kunci beban"]);

  // PEMBELIAN: barang master + kata beli/qty
  const buying = BUY_WORDS.test(text.toLowerCase());
  const buy = detectPurchase(text, ctx.items, hint.direction ?? "KELUAR");
  {
    let s = 0;
    const why: string[] = [];
    if (buying) { s += 45; why.push("kata beli"); }
    if (buy) { s += 40; why.push(`barang ${buy.item.name}`); }
    if (qty) { s += buy ? 15 : 5; why.push("jumlah"); }
    if (supplierHit) { s += 10; why.push("supplier"); }
    if (hint.amount) s += 5;
    // "beli lpg / ongkir / konsumsi ..." tanpa barang master: kata beli hanya kata kerja, jenisnya BEBAN
    if ((buying || buy) && !(!buy && cands.some((c) => c.kind === "BEBAN"))) add("PEMBELIAN", s, why);
  }

  // BAYAR HUTANG: kata angsuran + utang terbuka cocok
  {
    const debtWord = DEBT_WORDS.test(text);
    const hit = detectPayablePayment(text, ctx.payables, hint.direction ?? "KELUAR", hint.amount);
    let s = 0;
    const why: string[] = [];
    if (debtWord) { s += 45; why.push("kata angsur/hutang"); }
    if (hit?.matches.length) { s += hit.matches.length === 1 ? 40 : 30; why.push(`utang terbuka ${hit.matches[0].vendor}`); }
    if (debtWord || hit?.matches.length) add("BAYAR_HUTANG", debtWord ? s : Math.min(s, 40), why);
    // "bayar <supplier>" tanpa kata angsur/hutang: hanya nama supplier yang masih berutang → ragu (ditanyakan), bukan menebak
    else if (!buying && /\b(bayar|transfer|tf|setor|kirim)\b/i.test(text)) {
      const owed = ctx.payables.find((p) => [p.vendor, ...(p.aliases ?? [])].map(supplierKey).some((n) => n.length >= 4 && t.includes(` ${n} `)));
      if (owed) add("BAYAR_HUTANG", 35, [`supplier ${owed.vendor} masih berutang`]);
    }
  }

  // GAJI / UPAH (karyawan atau borongan)
  {
    const word = GAJI_WORDS.test(text) || PAY_WORDS.test(text);
    const emp = ctx.employees.some((n) => { const k = norm(n).trim(); return k.length >= 3 && t.includes(` ${k} `); });
    const borongan = /\bborongan\b/i.test(text);
    if (word) add("GAJI", 45 + (emp ? 30 : 0) + (borongan ? 20 : 0), ["kata gaji/upah", ...(emp ? ["nama karyawan"] : []), ...(borongan ? ["borongan"] : [])], { borongan });
  }

  // KOMPENSASI / sisihan pengelola
  {
    const intent = reserveIntent(text);
    const mgr = ctx.managers.some((n) => { const k = norm(n).trim(); return k.length >= 2 && t.includes(` ${k} `); });
    if (intent) add("KOMPENSASI", 80, ["kata kompensasi/sisihan"]);
    else if (COMP_WORDS.test(text) && mgr) add("KOMPENSASI", 60, ["kompensasi + nama pengelola"]);
  }

  // PENJUALAN / PEMASUKAN
  if (hint.direction === "MASUK" || SALE_WORDS.test(text)) add("PENJUALAN", (hint.direction === "MASUK" ? 55 : 0) + (SALE_WORDS.test(text) ? 30 : 0), ["pemasukan"]);

  const ranked = cands.sort((a, b) => b.score - a.score);
  const top = ranked[0] ?? null;
  const second = ranked[1];
  const ambiguous = !!top && (top.score < MIN_OK || (!!second && second.score >= MIN_OK && second.score >= top.score * 0.8));
  return { ranked, top, ambiguous };
}

/** Master data untuk pengenalan jenis (dibaca sekali per pesan) */
export async function loadClassifyContext(managers: string[] = DEFAULT_MANAGER_NAMES): Promise<ClassifyContext> {
  const [items, payables, suppliers, employees] = await Promise.all([
    rawMaterials(),
    openPayables(),
    prisma.supplier.findMany({ where: { active: true }, select: { id: true, name: true, aliases: true } }),
    prisma.employee.findMany({ where: { status: { not: "NONAKTIF" } }, select: { name: true, nickname: true } }),
  ]);
  return { items, payables, suppliers, employees: employees.flatMap((e) => [e.name, e.nickname].filter((x): x is string => !!x)), managers };
}
