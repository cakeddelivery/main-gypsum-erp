import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commitImport, undoImport } from "@/lib/marketplace/import";
import type { ParsedFile, ParsedIncome, ParsedOrder } from "@/lib/marketplace/parse";
import { inferStore, loadBrands } from "@/lib/marketplace/slots";

const num = Date.now().toString().slice(-6);
const actor = { id: "t", name: "Tester" };
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
async function store(code: "MG" | "DL", name: string) {
  const org = await prisma.organization.findFirstOrThrow();
  const ex = await prisma.store.findUnique({ where: { code } });
  if (ex) return ex;
  const made = await prisma.store.create({ data: { code, name, organizationId: org.id } });
  cleanups.unshift(() => prisma.store.delete({ where: { id: made.id } }));
  return made;
}
const at = (d: string) => new Date(`${d}T03:00:00Z`);
const order = (orderNo: string, name: string, sku = "X"): ParsedOrder => ({ orderNo, orderedAt: at("2048-02-03"), paidAt: null, completedAt: null, rawStatus: "Selesai", rawSubstatus: null, rawReturn: null, cancelReason: null, trackingNo: null, shipOption: null, courier: null, paymentMethod: null, city: null, province: null, creatorHandle: null, affiliate: false, subtotal: 50000, discount: 0, shippingPaid: 0, total: 50000, refundAmount: 0, returnQty: 0, lines: [{ sku, variation: null, name, qty: 1, unitPrice: 50000, amount: 50000, returnQty: 0 }] });
const file = (platform: "SHOPEE" | "TIKTOK", kind: "ORDER" | "INCOME", f: Partial<ParsedFile>): ParsedFile => ({ platform, kind, orders: [], incomes: [], withdrawals: [], periodFrom: null, periodTo: null, info: { rows: 0 }, ...f });
const inc = (refNo: string): ParsedIncome => ({ kind: "ORDER", refNo, orderedAt: at("2048-02-03"), releasedAt: at("2048-02-04"), released: 45000, productAmt: 50000, refundAmt: 0, fees: 5000, feeDetail: { Komisi: -5000 } });

describe("Deteksi toko dari isi file (tanpa username)", () => {
  it("merek di nama produk (≥80%), nomor pesanan (TikTok income pakai ID pesanan), mayoritas, SKU yang sudah dikenal, ragu → pilih manual", async () => {
    const dl = await store("DL", "Dunia Lukis");
    const mg = await store("MG", "Main Gypsum");
    const stores = [mg, dl].map((s) => ({ id: s.id, name: s.name }));
    const brands = await loadBrands(stores);
    const none = new Map<string, string>();

    // c) merek
    const dlFile = file("SHOPEE", "ORDER", { orders: Array.from({ length: 10 }, (_, i) => order(`${num}BR${i}`, i < 9 ? `DUNIA LUKIS Paket 24 ${i}` : "Produk tanpa merek")) });
    const r1 = await inferStore(dlFile, "SHP", stores, none, brands);
    expect(r1).toMatchObject({ storeId: dl.id, via: "MEREK" });
    expect(r1.reason).toMatch(/90%/);
    const mgFile = file("SHOPEE", "ORDER", { orders: Array.from({ length: 5 }, (_, i) => order(`${num}BM${i}`, `Main Gypsum Giftbox ${i}`)) });
    expect(await inferStore(mgFile, "SHP", stores, none, brands)).toMatchObject({ storeId: mg.id, via: "MEREK", confidence: "TINGGI" });
    // campur 50/50 → ragu (pilih manual)
    const mixed = file("SHOPEE", "ORDER", { orders: [order(`${num}X1`, "DUNIA LUKIS A"), order(`${num}X2`, "MAIN GYPSUM B")] });
    const r2 = await inferStore(mixed, "SHP", stores, none, brands);
    expect(r2.storeId).toBeUndefined();

    // b) nomor pesanan yang sudah tercatat di Dunia Lukis; TikTok income dikenali lewat ID pesanan
    const ids = Array.from({ length: 10 }, (_, i) => `${num}${String(i).padStart(2, "0")}9`);
    const [o] = await commitImport(actor, [{ fileName: `d.o.${num}.xlsx`, storeId: dl.id, parsed: file("TIKTOK", "ORDER", { orders: ids.map((n) => order(n, "produk")) }) }], { finalize: false });
    cleanups.push(() => undoImport(actor, o.importId));
    const tt = await inferStore(file("TIKTOK", "INCOME", { incomes: ids.map(inc) }), "TTS", stores, none, brands);
    expect(tt).toMatchObject({ storeId: dl.id, via: "PESANAN", confidence: "TINGGI" });
    // mayoritas ≥80% (9 dari 10 di DL, 1 baru) → tetap DL; 5/5 antar dua toko → ragu
    const maj = await inferStore(file("TIKTOK", "INCOME", { incomes: [...ids.slice(0, 9), `${num}NEW`].map(inc) }), "TTS", stores, none, brands);
    expect(maj.storeId).toBe(dl.id);
    const ids2 = Array.from({ length: 5 }, (_, i) => `${num}${i}88`);
    const [o2] = await commitImport(actor, [{ fileName: `m.o.${num}.xlsx`, storeId: mg.id, parsed: file("TIKTOK", "ORDER", { orders: ids2.map((n) => order(n, "produk")) }) }], { finalize: false });
    cleanups.push(() => undoImport(actor, o2.importId));
    const split = await inferStore(file("TIKTOK", "INCOME", { incomes: [...ids.slice(0, 5), ...ids2].map(inc) }), "TTS", stores, none, brands);
    expect(split.storeId).toBeUndefined();
    expect(split.reason).toMatch(/lebih dari satu toko/);

    // d) SKU yang hanya pernah muncul di pesanan Dunia Lukis (nama produk tanpa merek) → rendah yakinnya
    const sku = `ZZSKU${num}`;
    const [o3] = await commitImport(actor, [{ fileName: `s.o.${num}.xlsx`, storeId: dl.id, parsed: file("SHOPEE", "ORDER", { orders: [order(`${num}SK1`, "tanpa merek", sku)] }) }], { finalize: false });
    cleanups.push(() => undoImport(actor, o3.importId));
    const bySku = await inferStore(file("SHOPEE", "ORDER", { orders: [order(`${num}SK2`, "tanpa merek", sku)] }), "SHP", stores, none, brands);
    expect(bySku).toMatchObject({ storeId: dl.id, via: "SKU", confidence: "RENDAH" });

    // e) tidak ada petunjuk sama sekali → pilih manual
    const blank = await inferStore(file("SHOPEE", "ORDER", { orders: [order(`${num}ZZ`, "barang", `UNK${num}`)] }), "SHP", stores, none, brands);
    expect(blank.storeId).toBeUndefined();
    expect(blank.reason).toMatch(/pilih toko/);

    // a) username tersimpan menang
    const sellers = new Map([[`marketplace_seller:${mg.id}:SHP`, "mainshop"]]);
    const byUser = await inferStore(file("SHOPEE", "INCOME", { info: { rows: 0, seller: "MainShop" } }), "SHP", stores, sellers, brands);
    expect(byUser).toMatchObject({ storeId: mg.id, via: "USERNAME" });
  });
});
