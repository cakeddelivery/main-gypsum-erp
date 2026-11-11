import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { locationSettings } from "@/lib/stock";
import { normalizeUrl, saveItemRecord } from "@/lib/items";
import { createPurchase } from "@/lib/purchase";
import { autoRequestsFromReport, suggestedQty } from "@/lib/stockRequestAuto";
import { applyMenuChoice, effectivePermissions, overridesFor, MENU_GROUPS } from "@/lib/rbac";
import { nextTypeCode, productTypes } from "@/lib/productTypes";
import { dateOnly, jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
let storeId: string;
let s1: string;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  storeId = (await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } })).value;
  s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
  await locationSettings(prisma);
});

describe("Akses menu per role", () => {
  it("mematikan menu mencabut semua izinnya; menyalakan lagi memakai izin bawaan role", () => {
    const cur = effectivePermissions("ADMIN", []);
    const all = new Set(MENU_GROUPS.map((g) => g.key));
    all.delete("stock");
    const off = applyMenuChoice("ADMIN", cur, all);
    expect(["stock.view", "stock.move", "stock.approve", "master.manage"].some((p) => off.has(p as never))).toBe(false);
    expect(off.has("finance.view")).toBe(true);
    const ov = overridesFor("ADMIN", off);
    expect(ov.every((o) => !o.allowed)).toBe(true);
    // Disimpan sebagai override → izin efektif sama
    const eff = effectivePermissions("ADMIN", ov.map((o) => ({ role: "ADMIN" as const, ...o })));
    expect(eff.has("stock.view")).toBe(false);
    const back = applyMenuChoice("ADMIN", eff, new Set(MENU_GROUPS.map((g) => g.key)));
    expect(back.has("stock.approve")).toBe(true);
    // Operator tidak punya Akuntansi: dinyalakan = lihat saja
    const op = applyMenuChoice("OPERATOR", effectivePermissions("OPERATOR", []), new Set(["accounting", ...MENU_GROUPS.filter((g) => effectivePermissions("OPERATOR", []).has(g.perms[0])).map((g) => g.key)]));
    expect(op.has("accounting.view")).toBe(true);
    expect(op.has("accounting.post")).toBe(false);
    // Owner selalu penuh walau ada override
    expect(effectivePermissions("OWNER", [{ role: "OWNER", permission: "users.manage", allowed: false }]).has("users.manage")).toBe(true);
  });
});

describe("Item bahan baku: harga manual, OFFLINE/ONLINE, permintaan otomatis", () => {
  it("link produk dirapikan; item ONLINE wajib link", async () => {
    expect(normalizeUrl("shopee.co.id/abc")).toBe("https://shopee.co.id/abc");
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    await expect(saveItemRecord({ name: "Cat Online Uji", type: "BAHAN_BAKU", unit: "botol", hppFactor: 1, minStock: 1, buyMode: "ONLINE", productUrl: "" }, actor)).rejects.toThrow(/Link Produk/);
  });

  it("harga pembelian ÷ quantity = harga satuan; harga manual tercatat lalu ditimpa pembelian", async () => {
    const it = await saveItemRecord({ name: "Gypsum Harga Manual Uji", type: "BAHAN_BAKU", unit: "sak", hppUnit: "gram", hppFactor: 18000, minStock: 5, buyPrice: 720_000, buyQty: 10, buyMode: "ONLINE", productUrl: "tokopedia.com/gyp", orderQty: 10 }, actor);
    expect(Number(it.lastCost)).toBe(72_000);
    expect(it.productUrl).toBe("https://tokopedia.com/gyp");
    const upd = await saveItemRecord({ id: it.id, sku: it.sku, name: it.name, type: "BAHAN_BAKU", unit: "sak", hppUnit: "gram", hppFactor: 18000, minStock: 5, manualCost: { price: 400_000, qty: 5 } }, actor);
    expect(Number(upd.lastCost)).toBe(80_000);
    expect(upd.costManualBy).toBe(actor.name);
    expect(upd.buyMode).toBe("ONLINE"); // tidak dikirim = tidak berubah
    expect(await prisma.auditLog.count({ where: { action: "HARGA_ITEM_MANUAL", entityId: it.id } })).toBe(1);

    // Laporan shift stok 3 ≤ limit 5 → permintaan otomatis (5−3)+10 = 12, tidak dobel
    const divisionId = (await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PRODUKSI" } })).id;
    const rep = await prisma.shiftReport.create({ data: { date: dateOnly("2027-06-01"), shiftId: s1, divisionId, createdBy: "uji", stockCount: [{ itemId: it.id, name: it.name, unit: "sak", limit: 5, qty: 3 }] } });
    expect(await autoRequestsFromReport(rep.id, actor)).toEqual({ created: 1 });
    expect(await autoRequestsFromReport(rep.id, actor)).toEqual({ created: 0 });
    const req = await prisma.stockRequest.findFirstOrThrow({ where: { itemId: it.id } });
    expect(Number(req.qty)).toBe(12);
    expect(req.auto).toBe(true);
    expect(suggestedQty(5, 5, 0)).toBe(1);

    // Pembelian (tanggal lebih lama dari harga manual) tetap memperbarui harga & memenuhi permintaan
    await createPurchase({ supplierId: null, newSupplierName: "Toko Uji Harga", storeId, date: jakartaDateTime("2027-01-02", "10:00"), term: "TEMPO", paidNow: 0, bankAccountId: null, dueDate: jakartaDateTime("2027-02-02", "10:00"), note: null, lines: [{ itemId: it.id, qty: 4, amount: 300_000 }] }, actor);
    const after = await prisma.item.findUniqueOrThrow({ where: { id: it.id } });
    expect(Number(after.lastCost)).toBe(75_000);
    expect(after.costManualAt).toBeNull();
    expect(Number(after.buyPrice)).toBe(300_000);
    expect((await prisma.stockRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("DIPENUHI");
  });
});

describe("Tipe produk dari tabel", () => {
  it("tipe bawaan tersedia dan kode baru dibuat otomatis", async () => {
    const list = await productTypes(prisma);
    expect(list.map((t) => t.code)).toEqual(expect.arrayContaining(["SATUAN", "PAKET_12", "GIFTBOX"]));
    expect(await nextTypeCode(prisma, "Paket 12")).toBe("PAKET_12_2");
    expect(await nextTypeCode(prisma, "Paket 6 pcs")).toBe("PAKET_6_PCS");
  });
});
