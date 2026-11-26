import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";

// Audit Penjualan & Stok (26 Nov 2026): kirim ganda / paralel tidak boleh membuat data dobel
let actor: { id: string; name: string; can: () => boolean };
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), assertPerm: vi.fn(async () => actor) }));

import { action } from "@/lib/action";
import { createSale } from "@/lib/sales";
import { createReturn } from "@/lib/returns";
import { saveItemRecord } from "@/lib/items";
import { resolveSupplier } from "@/lib/suppliers";
import { saveCustomer, saveSupplier } from "@/app/(app)/supplier/actions";
import { jakartaDateTime } from "@/lib/time";

const tag = Date.now().toString(36).slice(-5);
const d = (s: string) => jakartaDateTime(s, "10:00");
const fdOf = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
let storeId: string;
let seabank: string;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name, can: () => true };
  storeId = (await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } })).value;
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
});

describe("Token kirim-form (action)", () => {
  it("2x berturut-turut dengan token sama: aksi jalan sekali, kirim kedua mengembalikan pesan sukses yang sama", async () => {
    let runs = 0;
    const act = action("sales.manage", async () => { runs++; return `Tercatat ${runs}`; });
    const a = await act(null, fdOf({ _idem: `seq-${tag}-aaaa` }));
    const b = await act(null, fdOf({ _idem: `seq-${tag}-aaaa` }));
    expect(runs).toBe(1);
    expect(a).toMatchObject({ ok: true, message: "Tercatat 1" });
    expect(b).toMatchObject({ ok: true, message: "Tercatat 1" });
  });
  it("2x paralel dengan token sama: aksi jalan sekali", async () => {
    let runs = 0;
    const act = action("sales.manage", async () => { runs++; await new Promise((r) => setTimeout(r, 150)); return "ok"; });
    const [a, b] = await Promise.all([act(null, fdOf({ _idem: `par-${tag}-aaaa` })), act(null, fdOf({ _idem: `par-${tag}-aaaa` }))]);
    expect(runs).toBe(1);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
  it("gagal melepas token: kirim ulang dengan token sama boleh jalan; token beda = pekerjaan baru", async () => {
    let runs = 0;
    const act = action("sales.manage", async () => { runs++; if (runs === 1) throw new Error("Isian salah"); return "ok"; });
    expect((await act(null, fdOf({ _idem: `gal-${tag}-aaaa` }))).ok).toBe(false);
    expect((await act(null, fdOf({ _idem: `gal-${tag}-aaaa` }))).ok).toBe(true);
    expect((await act(null, fdOf({ _idem: `gal-${tag}-bbbb` }))).ok).toBe(true);
    expect(runs).toBe(3);
  });
  it("tanpa token (klien lama) tetap jalan seperti biasa", async () => {
    let runs = 0;
    const act = action("sales.manage", async () => { runs++; });
    await act(null, fdOf({}));
    await act(null, fdOf({}));
    expect(runs).toBe(2);
  });
});

describe("Master ganda saat paralel / kirim ulang", () => {
  it("penjualan paralel dengan pelanggan baru bernama sama → satu pelanggan", async () => {
    const it = await prisma.item.create({ data: { sku: `AD-${tag}-1`, name: `Produk AD ${tag}`, type: "BARANG_JADI", unit: "pcs" } });
    const mk = () => createSale({ date: d("2027-07-02"), storeId, newCustomerName: `Bu Paralel ${tag}`, lines: [{ itemId: it.id, qty: 1, price: 1000 }], paidNow: 1000, bankAccountId: seabank }, actor);
    await Promise.all([mk(), mk(), mk()]);
    expect(await prisma.customer.count({ where: { name: { equals: `Bu Paralel ${tag}`, mode: "insensitive" } } })).toBe(1);
  });
  it("saveCustomer 2x / paralel dengan nama sama → hanya satu", async () => {
    const f = () => saveCustomer(null, fdOf({ name: `Pak Ganda ${tag}` }));
    const r = await Promise.all([f(), f()]);
    await f();
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(await prisma.customer.count({ where: { name: `Pak Ganda ${tag}` } })).toBe(1);
  });
  it("saveSupplier & pembelian dengan supplier baru bernama sama paralel → satu supplier", async () => {
    const f = () => saveSupplier(null, fdOf({ name: `Toko Ganda ${tag}` }));
    const r = await Promise.all([f(), f()]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    const g = () => prisma.$transaction((tx) => resolveSupplier(tx, { name: `CV Paralel ${tag}` }, actor, "tes"));
    await Promise.all([g(), g(), g()]);
    expect(await prisma.supplier.count({ where: { name: `CV Paralel ${tag}` } })).toBe(1);
  });
  it("item baru bernama sama (klik ganda) ditolak: tidak ada item & stok awal kedua; paralel hanya satu lolos", async () => {
    const mk = () => saveItemRecord({ name: `Lem Ganda ${tag}`, type: "BAHAN_BAKU", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty: 5 }, actor);
    const r = await Promise.allSettled([mk(), mk()]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    await expect(mk()).rejects.toThrow(/sudah ada/);
    const items = await prisma.item.findMany({ where: { name: `Lem Ganda ${tag}` } });
    expect(items).toHaveLength(1);
    expect(await prisma.stockMovement.count({ where: { itemId: items[0].id } })).toBe(1);
  });
  it("retur dengan resi sama dikirim paralel → hanya satu tercatat", async () => {
    const it = await prisma.item.create({ data: { sku: `AD-${tag}-R`, name: `Produk Retur ${tag}`, type: "BARANG_JADI", unit: "pcs" } });
    const base = { receivedAt: d("2027-07-03"), trackingNo: `SPXID${tag}000`, lines: [{ labelSku: "X", qty: 1, itemId: it.id }] };
    const r = await Promise.allSettled([createReturn(base, actor), createReturn({ ...base, confirmDup: true }, actor)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.returnCase.count({ where: { trackingNo: base.trackingNo.toUpperCase() } })).toBe(1);
  });
});
