/**
 * Baca label pengiriman marketplace (fungsi murni, dipakai di browser & server, diuji di tests/retur.unit.test.ts).
 * DATA PRIBADI: yang diambil hanya marketplace, kurir, no. resi, no. pesanan, kota/kab + provinsi tujuan, dan daftar
 * produk. Nama, alamat jalan, dan no. HP pembeli TIDAK pernah dikembalikan oleh fungsi di sini.
 */

export const MARKETPLACES = [
  { key: "SHOPEE", label: "Shopee" },
  { key: "TIKTOK", label: "TikTok Shop / Tokopedia" },
  { key: "LAINNYA", label: "Lainnya" },
] as const;
export const marketplaceLabel = (k: string | null | undefined) => MARKETPLACES.find((m) => m.key === k)?.label ?? k ?? "-";

export const COURIERS = ["SPX", "J&T", "J&T Cargo", "JNE", "SiCepat", "AnterAja", "Ninja", "ID Express", "Pos", "Lion Parcel", "GoSend", "GrabExpress", "Lainnya"];

export const PROVINCES = [
  "Aceh", "Sumatera Utara", "Sumatera Barat", "Riau", "Kepulauan Riau", "Jambi", "Sumatera Selatan", "Kepulauan Bangka Belitung", "Bengkulu", "Lampung",
  "DKI Jakarta", "Jawa Barat", "Banten", "Jawa Tengah", "DI Yogyakarta", "Jawa Timur", "Bali", "Nusa Tenggara Barat", "Nusa Tenggara Timur",
  "Kalimantan Barat", "Kalimantan Tengah", "Kalimantan Selatan", "Kalimantan Timur", "Kalimantan Utara",
  "Sulawesi Utara", "Gorontalo", "Sulawesi Tengah", "Sulawesi Barat", "Sulawesi Selatan", "Sulawesi Tenggara",
  "Maluku", "Maluku Utara", "Papua", "Papua Barat", "Papua Barat Daya", "Papua Selatan", "Papua Tengah", "Papua Pegunungan",
];

const PROVINCE_ALIAS: Record<string, string> = {
  JATIM: "Jawa Timur", JATENG: "Jawa Tengah", JABAR: "Jawa Barat", "D.I. YOGYAKARTA": "DI Yogyakarta", YOGYAKARTA: "DI Yogyakarta", "DAERAH ISTIMEWA YOGYAKARTA": "DI Yogyakarta",
  "DKI": "DKI Jakarta", JAKARTA: "DKI Jakarta", "BANGKA BELITUNG": "Kepulauan Bangka Belitung", NTB: "Nusa Tenggara Barat", NTT: "Nusa Tenggara Timur", SUMUT: "Sumatera Utara", SUMBAR: "Sumatera Barat", SUMSEL: "Sumatera Selatan",
  KALBAR: "Kalimantan Barat", KALTENG: "Kalimantan Tengah", KALSEL: "Kalimantan Selatan", KALTIM: "Kalimantan Timur", KALTARA: "Kalimantan Utara", SULSEL: "Sulawesi Selatan", SULUT: "Sulawesi Utara", SULTENG: "Sulawesi Tengah", SULTRA: "Sulawesi Tenggara", SULBAR: "Sulawesi Barat",
  "NANGGROE ACEH DARUSSALAM": "Aceh", NAD: "Aceh",
};

const up = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

/** Nama provinsi baku (Title Case) dari teks bebas; null bila tidak dikenali */
export function normalizeProvince(s: string | null | undefined): string | null {
  if (!s) return null;
  const u = up(s).replace(/^PROV(INSI|\.)?\s+/, "");
  if (PROVINCE_ALIAS[u]) return PROVINCE_ALIAS[u];
  // yang paling panjang dulu: "Papua Barat Daya" sebelum "Papua Barat" sebelum "Papua"
  const hit = [...PROVINCES].sort((a, b) => b.length - a.length).find((p) => u === up(p) || u.endsWith(` ${up(p)}`) || u.startsWith(`${up(p)} `));
  return hit ?? null;
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());

/** "KAB. LAMONGAN" / "Kabupaten Lamongan" → "Kab. Lamongan"; "KOTA SURABAYA" → "Kota Surabaya". Teks berisi angka/alamat jalan ditolak. */
export function normalizeCity(s: string | null | undefined): string | null {
  if (!s) return null;
  const u = up(s).replace(/[.,;:]+$/, "");
  if (/\d|\bJL\b|\bJALAN\b|\bRT\b|\bRW\b|\bNO\b|\bGG\b|\bDESA\b|\bDUSUN\b/.test(u)) return null;
  const m = u.match(/^(KAB(?:UPATEN)?\.?|KOTA|KOTAMADYA|KOTA ADM\.?|KOTA ADMINISTRASI)\s+(.+)$/);
  if (m) return `${m[1].startsWith("KAB") ? "Kab." : "Kota"} ${titleCase(m[2].trim())}`.slice(0, 60);
  if (u.length < 3 || u.length > 40 || u.split(" ").length > 4) return null;
  return titleCase(u);
}

/** Cari kota/kab & provinsi di teks OCR label (bagian alamat lain diabaikan) */
export function findPlace(text: string): { city: string | null; province: string | null } {
  const U = up(text.replace(/\n/g, " \n "));
  let province: string | null = null;
  for (const p of [...PROVINCES].sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${up(p).replace(/ /g, "\\s+")}\\b`).test(U)) { province = p; break; }
  }
  if (!province) for (const [k, v] of Object.entries(PROVINCE_ALIAS)) if (k.length >= 4 && new RegExp(`\\b${k.replace(/\./g, "\\.")}\\b`).test(U)) { province = v; break; }
  const stop = `(?=\\s*[,\\n]|\\s+(?:${PROVINCES.map((p) => up(p).replace(/ /g, "\\s+")).join("|")}|KEC\\b|KECAMATAN|\\d)|$)`;
  const m = U.match(new RegExp(`\\b(KAB(?:UPATEN)?\\.?|KOTA)\\s+([A-Z][A-Z'\\- ]{2,30}?)${stop}`));
  const city = m ? normalizeCity(`${m[1]} ${m[2]}`) : null;
  return { city, province };
}

export type CodeGuess = { trackingNo: string | null; orderNo: string | null; courier: string | null; marketplace: string | null; codes: string[] };

/** Kenali isi barcode label: no. resi (dan kurirnya) vs no. pesanan (dan marketplacenya) */
export function classifyCodes(raw: string[]): CodeGuess {
  const codes = [...new Set(raw.map((c) => c.trim().toUpperCase().replace(/\s+/g, "")).filter((c) => /^[A-Z0-9-]{6,40}$/.test(c)))];
  let trackingNo: string | null = null;
  let orderNo: string | null = null;
  let courier: string | null = null;
  let marketplace: string | null = null;
  for (const c of codes) {
    if (!trackingNo && /^SPXID\d{8,}[A-Z0-9]*$/.test(c)) { trackingNo = c; courier = "SPX"; marketplace ??= "SHOPEE"; continue; }
    if (!trackingNo && /^J[A-Z]\d{10,14}$/.test(c)) { trackingNo = c; courier = "J&T"; continue; }
    if (!orderNo && /^\d{6}[A-Z0-9]{8}$/.test(c) && /[A-Z]/.test(c.slice(6))) { orderNo = c; marketplace = "SHOPEE"; continue; }
    if (!orderNo && /^5\d{17}$/.test(c)) { orderNo = c; marketplace = "TIKTOK"; continue; }
  }
  if (!trackingNo) {
    // Resi lain (JNE, SiCepat, J&T Cargo, …): kode terpanjang yang bukan no. pesanan
    const rest = codes.filter((c) => c !== orderNo && c.length >= 10).sort((a, b) => b.length - a.length);
    trackingNo = rest[0] ?? null;
    if (trackingNo && /^\d{12,15}$/.test(trackingNo) && !courier) courier = null;
  }
  return { trackingNo, orderNo, courier, marketplace, codes };
}

export type LabelLine = { sku: string | null; variation: string | null; name: string | null; qty: number };
export type LabelRead = {
  marketplace: string | null;
  courier: string | null;
  trackingNo: string | null;
  orderNo: string | null;
  city: string | null;
  province: string | null;
  lines: LabelLine[];
};

/** Kurir & marketplace dari kata kunci di teks label */
function keywords(U: string) {
  const marketplace = /SHOPEE/.test(U) ? "SHOPEE" : /TIKTOK|TOKOPEDIA/.test(U) ? "TIKTOK" : null;
  const courier = /\bSPX\b|SHOPEE ?XPRESS/.test(U) ? "SPX" : /J ?& ?T ?CARGO|\bJTR\b/.test(U) ? "J&T Cargo" : /J ?& ?T|\bJNT\b|J&T EXPRESS/.test(U) ? "J&T" : /\bJNE\b/.test(U) ? "JNE" : /SICEPAT/.test(U) ? "SiCepat" : /ANTERAJA/.test(U) ? "AnterAja" : /NINJA/.test(U) ? "Ninja" : /ID ?EXPRESS/.test(U) ? "ID Express" : null;
  return { marketplace, courier };
}

/**
 * Baca teks OCR label (cadangan bila AI tidak tersedia). Hanya pola yang aman diambil:
 * baris produk "SKU ... qty" / "Seller SKU: X", no. resi/pesanan, kota/kab & provinsi.
 */
export function parseLabelText(text: string): LabelRead {
  const U = up(text);
  const kw = keywords(U);
  const tokens = (U.match(/\b[A-Z0-9-]{8,30}\b/g) ?? []).filter((t) => /\d/.test(t));
  const g = classifyCodes(tokens);
  const order = U.match(/(?:NO\.?\s*PESANAN|ORDER\s*ID|NO\.?\s*ORDER)\s*[:#]?\s*([A-Z0-9]{8,24})/);
  const resi = U.match(/(?:NO\.?\s*RESI|RESI|AWB|TRACKING(?:\s*NO)?)\s*[:#]?\s*([A-Z0-9]{8,30})/);
  const place = findPlace(text);
  const lines: LabelLine[] = [];
  const rows = text.split(/\n+/).map((r) => r.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (const r of rows) {
    const R = up(r);
    // "Seller SKU GIFT-CEW, STANDARD,CEWEK, 1" / "SKU: GIFT-MIX Variasi: STANDARD,MIX Qty: 12"
    const m = R.match(/(?:SELLER\s+)?SKU\s*[:.]?\s*([A-Z0-9][A-Z0-9-]{2,30})\s*[,;]?\s*(?:VARIASI\s*[:.]?\s*)?([A-Z ,]{0,40}?)\s*[,;]?\s*(?:QTY|JUMLAH|X)?\s*[:.]?\s*(\d{1,4})\s*$/);
    if (m) {
      lines.push({ sku: m[1], variation: m[2].replace(/^[, ]+|[, ]+$/g, "") || null, name: null, qty: Number(m[3]) || 1 });
      continue;
    }
    // "MG-24HWN Hewan 24 Pcs 2" (kode produk di depan, qty di akhir)
    const p = R.match(/^([A-Z]{2,5}-[A-Z0-9-]{2,20})\s+(.{2,60}?)\s+(\d{1,4})$/);
    if (p) lines.push({ sku: p[1], variation: null, name: titleCase(p[2]), qty: Number(p[3]) || 1 });
  }
  return {
    marketplace: g.marketplace ?? kw.marketplace,
    // Kata kunci lebih spesifik dari bentuk barcode (resi J&T Cargo mirip resi J&T biasa)
    courier: kw.courier === "J&T Cargo" ? kw.courier : g.courier ?? kw.courier,
    trackingNo: resi?.[1] ?? g.trackingNo,
    orderNo: order?.[1] ?? g.orderNo,
    city: place.city,
    province: place.province,
    lines,
  };
}

/** Rapikan hasil baca (AI/OCR) dan buang apa pun di luar daftar kolom yang boleh disimpan */
export function sanitizeLabel(x: Partial<Record<string, unknown>> | null | undefined): LabelRead {
  const s = (v: unknown, max = 40) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const mpRaw = up(s(x?.marketplace) ?? "");
  const marketplace = /SHOPEE/.test(mpRaw) ? "SHOPEE" : /TIKTOK|TOKOPEDIA/.test(mpRaw) ? "TIKTOK" : mpRaw ? "LAINNYA" : null;
  const code = (v: unknown) => {
    const c = s(v, 40)?.toUpperCase().replace(/\s+/g, "") ?? null;
    return c && /^[A-Z0-9-]{6,40}$/.test(c) ? c : null;
  };
  const rawLines = Array.isArray(x?.lines) ? (x!.lines as unknown[]) : Array.isArray(x?.items) ? (x!.items as unknown[]) : [];
  const lines: LabelLine[] = rawLines.slice(0, 20).map((l) => {
    const o = (l ?? {}) as Record<string, unknown>;
    const qty = Math.round(Number(o.qty ?? o.quantity ?? 1));
    return { sku: s(o.sku, 40)?.toUpperCase() ?? null, variation: s(o.variation ?? o.variasi, 60)?.toUpperCase() ?? null, name: s(o.name ?? o.nama, 80), qty: qty > 0 && qty < 10000 ? qty : 1 };
  }).filter((l) => l.sku || l.name);
  return {
    marketplace,
    courier: s(x?.courier, 30),
    trackingNo: code(x?.trackingNo ?? x?.resi),
    orderNo: code(x?.orderNo ?? x?.order),
    city: normalizeCity(s(x?.city, 60)),
    province: normalizeProvince(s(x?.province, 60)),
    lines,
  };
}

/** Gabung hasil baca: barcode (paling akurat untuk resi) > AI > OCR */
export function mergeLabel(...reads: (Partial<LabelRead> | null | undefined)[]): LabelRead {
  const pick = <K extends keyof LabelRead>(k: K) => (reads.find((r) => r && r[k] && (!Array.isArray(r[k]) || (r[k] as unknown[]).length))?.[k] ?? (k === "lines" ? [] : null)) as LabelRead[K];
  return { marketplace: pick("marketplace"), courier: pick("courier"), trackingNo: pick("trackingNo"), orderNo: pick("orderNo"), city: pick("city"), province: pick("province"), lines: pick("lines") };
}

// ---------------- Pemetaan SKU marketplace → barang jadi ERP ----------------

export type CatalogEntry = { itemId: string; sku: string; name: string; words: string[] };

/** Kunci peta SKU: "GIFT-MIX|STANDARD,MIX" (huruf besar, tanpa spasi) */
export const skuKey = (sku: string | null | undefined, variation?: string | null) => `${(sku ?? "").toUpperCase().replace(/\s+/g, "")}|${(variation ?? "").toUpperCase().replace(/\s+/g, "")}`;

const consonants = (w: string) => w.replace(/[AEIOU]/g, "");
function tokenize(s: string) {
  return up(s).split(/[^A-Z0-9]+/).flatMap((t) => t.match(/[A-Z]+|\d+/g) ?? []).filter((t) => t.length >= 2 || /\d/.test(t));
}
/** Token label cocok dengan kata katalog: sama, awalan (CEW → CEWEK, GIFT → GIFTBOX), atau kerangka konsonan (HWN → HEWAN) */
function tokenHit(t: string, words: string[]) {
  return words.some((w) => w === t || (t.length >= 3 && w.startsWith(t)) || (t.length >= 3 && !/\d/.test(t) && consonants(w) === t) || (t.length >= 3 && !/\d/.test(t) && consonants(w).startsWith(t) && t === consonants(t)));
}

/**
 * Cari barang jadi untuk satu baris label. Urutan: peta yang pernah dikonfirmasi → SKU sama persis → kemiripan kata
 * (SKU + variasi + nama vs SKU/nama produk + pilihan varian). Null bila tidak yakin (pengguna memilih sendiri).
 */
export function matchItem(line: Pick<LabelLine, "sku" | "variation" | "name">, catalog: CatalogEntry[], maps: Map<string, string> = new Map()): { itemId: string; by: "PETA" | "SKU" | "MIRIP" } | null {
  const known = maps.get(skuKey(line.sku, line.variation)) ?? (line.sku ? maps.get(skuKey(line.sku, "")) : undefined);
  if (known && catalog.some((c) => c.itemId === known)) return { itemId: known, by: "PETA" };
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (line.sku) {
    const same = catalog.filter((c) => norm(c.sku) === norm(line.sku!));
    if (same.length === 1 && !line.variation) return { itemId: same[0].itemId, by: "SKU" };
  }
  const tokens = [...new Set(tokenize([line.sku, line.variation, line.name].filter(Boolean).join(" ")))].filter((t) => !["PCS", "PC", "SET", "MG", "DL"].includes(t));
  if (!tokens.length) return null;
  const scored = catalog
    .map((c) => {
      const words = [...new Set([...tokenize(c.sku), ...tokenize(c.name), ...c.words.flatMap(tokenize)])];
      const hits = tokens.filter((t) => tokenHit(t, words)).length;
      // pembagi: token label; sedikit penalti untuk kata katalog yang tidak disebut (produk lebih spesifik kalah)
      return { c, score: hits / tokens.length - Math.max(0, words.length - hits) * 0.01 };
    })
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score < 0.6) return null;
  if (second && best.score - second.score < 0.05) return null;
  return { itemId: best.c.itemId, by: "MIRIP" };
}
