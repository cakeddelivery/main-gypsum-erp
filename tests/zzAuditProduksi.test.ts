/**
 * AUDIT PRODUKSI pasca cut-over (stok_terpadu_mulai): mensimulasikan aksi utama tiap divisi (Cetak, Oven, Assembling,
 * Giftbox, Packing) dan pembatasan per peran, lalu melaporkan setiap kegagalan beserta pesannya.
 * File ini sengaja bernama zz… agar berjalan terakhir (membuat data uji tambahan). Dijalankan juga lewat `npm run audit:produksi` (hanya database uji lokal, tidak menyentuh data produksi).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import type { Role } from "@prisma/client";
import { DEFAULT_MATRIX, effectivePermissions } from "@/lib/rbac";
import { locationSettings, qtyAt } from "@/lib/stock";
import { CUTOVER_SETTING, FLOW_SETTING, flowItem, postShiftWork } from "@/lib/shiftReportFlow";
import { addHarvest } from "@/lib/shiftHarvest";
import { addShiftReceipt, removeShiftReceipt } from "@/lib/shiftReceipt";
import { applyReportRejects, REJECT_KEY } from "@/lib/productionReject";
import { applyReportSamples, SAMPLE_KEY } from "@/lib/affiliateSample";
import { applyLpg, LPG_KEY } from "@/lib/lpg";
import { applyShiftStockCount } from "@/lib/shiftReportStock";
import { recordProductionEntry } from "@/lib/productionEntry";
import { saveItemRecord } from "@/lib/items";
import { boronganScope } from "@/lib/borongan";
import { canCompleteAssembling, canInputKering, canReceive, canShip } from "@/lib/boronganFlow";
import { canSeeDivision } from "@/lib/reportScope";
import { dateOnly, jakartaDateTime } from "@/lib/time";
import type { WorkData } from "@/lib/shiftReport";

type Actor = { id: string; name: string; role?: string };
const TEMPLATES = ["CETAK", "PRODUKSI", "ASSEMBLING", "GIFTBOX", "PACKING"] as const;
const tag = Date.now().toString(36).slice(-4).toUpperCase();

describe("Audit produksi pasca cut-over", () => {
  let owner: Actor;
  let s1: string;
  let wip: string;
  let finished: string;
  const div = {} as Record<(typeof TEMPLATES)[number], { id: string; name: string }>;
  let prev: { key: string; value: string }[] = [];
  let day = 0;
  const nextDate = () => `2037-02-${String(10 + ++day).padStart(2, "0")}`;
  const mkReport = (t: (typeof TEMPLATES)[number], date: string, work: WorkData = {}, extra: Record<string, unknown> = {}) =>
    prisma.shiftReport.create({ data: { date: dateOnly(date), shiftId: s1, divisionId: div[t].id, createdBy: "audit", work: work as object, ...extra } });

  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    owner = { id: u.id, name: u.name, role: "OWNER" };
    for (const t of TEMPLATES) div[t] = await prisma.division.findFirstOrThrow({ where: { reportTemplate: t }, select: { id: true, name: true } });
    s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
    ({ wip, finished } = (await locationSettings(prisma)) as { wip: string; finished: string });
    // Kondisi produksi: stok terpadu menyala sejak awal tahun (laporan & input hari ini sudah pasca cut-over)
    prev = await prisma.setting.findMany({ where: { key: { in: [FLOW_SETTING, CUTOVER_SETTING] } } });
    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    await prisma.setting.upsert({ where: { key: CUTOVER_SETTING }, create: { key: CUTOVER_SETTING, value: "2026-01-01" }, update: { value: "2026-01-01" } });
  });
  afterAll(async () => {
    // Kembalikan pengaturan semula (file ini dijalankan terakhir, tetapi tetap jangan meninggalkan jejak)
    for (const key of [FLOW_SETTING, CUTOVER_SETTING]) {
      const old = prev.find((x) => x.key === key);
      if (old) await prisma.setting.update({ where: { key }, data: { value: old.value } });
      else await prisma.setting.deleteMany({ where: { key } });
    }
  });

  it("semua divisi berformat laporan ada & bisa dibuka anggotanya sendiri (tidak divisi lain)", () => {
    for (const t of TEMPLATES) {
      const user = { role: "OPERATOR", divisionId: div[t].id, employeeId: "x" } as Parameters<typeof canSeeDivision>[0];
      expect(canSeeDivision(user, div[t].id), `${t}: anggota harus bisa membuka laporan divisinya`).toBe(true);
      const other = TEMPLATES.find((x) => x !== t)!;
      expect(canSeeDivision(user, div[other].id), `${t}: tidak boleh membuka laporan ${other}`).toBe(false);
    }
  });

  it("CETAK: kirim laporan → + patung cetak; revisi tidak dobel", async () => {
    const kering = await prisma.$transaction((tx) => flowItem(tx, { kind: "basah", key: "Cewek" }));
    const q0 = await qtyAt(prisma, kering, wip);
    const r = await mkReport("CETAK", nextDate(), { cetakSeries: [{ name: "Ani", v: [null, null, null, 120] }] });
    await postShiftWork(r.id, owner, jakartaDateTime("2037-03-01", "09:00"));
    expect(await qtyAt(prisma, kering, wip)).toBe(q0 + 120);
    await prisma.shiftReport.update({ where: { id: r.id }, data: { work: { cetakSeries: [{ name: "Ani", v: [null, null, null, 100] }] } } });
    await postShiftWork(r.id, owner, jakartaDateTime("2037-03-01", "10:00"));
    expect(await qtyAt(prisma, kering, wip)).toBe(q0 + 100);
  });

  it("OVEN: panen realtime + kirim laporan + reject + LPG tidak error dan tidak dobel", async () => {
    const kering = await prisma.$transaction((tx) => flowItem(tx, { kind: "kering", key: "Cowok" }));
    const basah = await prisma.$transaction((tx) => flowItem(tx, { kind: "basah", key: "Cowok" }));
    const k0 = await qtyAt(prisma, kering, wip);
    const b0 = await qtyAt(prisma, basah, wip);
    const r = await mkReport("PRODUKSI", nextDate());
    const op: Actor = { id: "audit-op", name: "Operator Oven", role: "OPERATOR" };
    await addHarvest(r.id, { oven: "Oven Besar", lines: [{ variant: "Cowok", good: 50, reject: 5 }] }, op);
    expect(await qtyAt(prisma, kering, wip), "panen realtime harus langsung menambah patung kering").toBe(k0 + 50);
    const w = (await prisma.shiftReport.findUniqueOrThrow({ where: { id: r.id } })).work as Record<string, unknown>;
    await prisma.shiftReport.update({ where: { id: r.id }, data: { work: { ...w, [REJECT_KEY]: [{ itemId: basah, qty: 2, reason: "PECAH" }], [LPG_KEY]: { penuh: 1, aktif: 1, kosong: 1, isiUlang: 0 } } as object } });
    await postShiftWork(r.id, owner);
    await applyReportRejects(r.id, owner);
    await applyLpg(r.id, "audit");
    expect(await qtyAt(prisma, kering, wip), "kirim laporan tidak boleh memposting panen dua kali").toBe(k0 + 50);
    expect(await qtyAt(prisma, basah, wip)).toBe(b0 - 55 - 2);
  });

  it("barang masuk (penerimaan bahan) & stok akhir dapat dicatat pasca cut-over di tiap divisi", async () => {
    for (const t of TEMPLATES) {
      const item = await saveItemRecord({ name: `Bahan Audit ${t} ${tag}`, type: "BAHAN_BAKU", category: "Bahan Pendukung", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty: 10, divisionId: div[t].id }, owner);
      const r = await mkReport(t, nextDate(), {}, { stockCount: [{ itemId: item.id, name: item.name, unit: "pcs", limit: 0, qty: 12 }] });
      const rc = await addShiftReceipt(r.id, { itemId: item.id, qty: 5, supplierName: "Audit" }, owner);
      expect(rc.number, `${t}: nomor barang masuk`).toMatch(/BMK/);
      await expect(applyShiftStockCount(r.id, owner), `${t}: stok akhir shift`).resolves.toBeTruthy();
      await removeShiftReceipt(rc.id, owner).catch(() => {}); // setelah stok akhir diterapkan boleh ditolak; bukan kegagalan alur
    }
  });

  it("GIFTBOX: patung kering keluar 5 per box, giftbox masuk lalu keluar (HPP)", async () => {
    const kering = await prisma.$transaction((tx) => flowItem(tx, { kind: "kering", key: "Hewan" }));
    const k0 = await qtyAt(prisma, kering, wip);
    const r = await mkReport("GIFTBOX", nextDate(), { giftbox: { HWN: 2 } });
    await expect(postShiftWork(r.id, owner)).resolves.toMatchObject({ posted: expect.any(Number) });
    expect(await qtyAt(prisma, kering, wip)).toBe(k0 - 10);
  });

  it("PACKING: satuan keluar dari barang jadi + sample affiliator terposting", async () => {
    const jadi = await prisma.$transaction((tx) => flowItem(tx, { kind: "jadi", key: "Hewan" }));
    const j0 = await qtyAt(prisma, jadi, finished);
    const orgId = (await prisma.store.findFirstOrThrow()).organizationId;
    const store = await prisma.store.create({ data: { code: `AUD${tag}`, name: `Toko Audit ${tag}`, organizationId: orgId } });
    const r = await mkReport("PACKING", nextDate(), { satuan: { hewan: 4 }, [SAMPLE_KEY]: [{ itemId: jadi, qty: 1, platform: "SHOPEE", storeId: store.id }] } as unknown as WorkData);
    await postShiftWork(r.id, owner);
    const smp = await applyReportSamples(r.id, owner);
    expect(smp).toMatchObject({ rows: 1, posted: 1 });
    expect(await qtyAt(prisma, jadi, finished)).toBe(j0 - 5);
  });

  it("ASSEMBLING: laporan tidak mengubah stok (stok dari borongan); kirim laporan tidak error", async () => {
    const r = await mkReport("ASSEMBLING", nextDate(), { jadi: [{ name: "Eva", v: [10, null, 5, null] }] });
    await expect(postShiftWork(r.id, owner)).resolves.toMatchObject({ posted: 0 });
  });

  it("KUNCI pasca cut-over: input produksi manual hanya Owner; peran lain ditolak dengan pesan jelas", async () => {
    const emp = await prisma.employee.findFirstOrThrow({ where: { status: { not: "NONAKTIF" } } });
    const product = await prisma.product.findFirstOrThrow();
    const input = { date: "2037-04-01", shiftId: s1, divisionId: div.CETAK.id, employeeId: emp.id, stage: "FILLING_CAT", productId: product.id, qtyGood: 1, qtyReject: 0, rejectReason: null };
    for (const role of ["ADMIN", "ADMIN_PRODUKSI", "SUPERVISOR"] as const)
      await expect(recordProductionEntry(input, { id: owner.id, name: "x", role, employeeId: null, divisionId: null }), `${role} ditolak`).rejects.toThrow(/Laporan Shift/);
    await expect(recordProductionEntry(input, { id: owner.id, name: owner.name, role: "OWNER", employeeId: null, divisionId: null })).resolves.toBeTruthy();
  });

  it("MATRIKS PERAN: hak laporan shift, panen & borongan per peran sesuai peruntukan", async () => {
    const can = (role: Role, p: Parameters<ReturnType<typeof effectivePermissions>["has"]>[0]) => effectivePermissions(role, []).has(p);
    // Laporan shift
    for (const role of ["OPERATOR", "KAPTEN_DIVISI", "SUPERVISOR", "ADMIN", "ADMIN_PRODUKSI", "OWNER"] as const) expect(can(role, "report.create"), `${role}: report.create`).toBe(true);
    for (const role of ["DRIVER", "KOORDINATOR", "FINANCE", "ADMIN_MARKETPLACE", "PIC_CONTENT"] as const) expect(can(role, "report.create"), `${role}: tidak report.create`).toBe(false);
    // Panen Oven
    for (const role of ["OPERATOR", "KAPTEN_DIVISI", "SUPERVISOR", "ADMIN", "ADMIN_PRODUKSI"] as const) expect(DEFAULT_MATRIX[role], `${role}: report.harvest`).toContain("report.harvest");
    // Borongan: Oven mengisi patung kering; Assembling melengkapi & kirim; Packing menerima
    const mk = (role: string, d: string) => ({ id: `audit-${role}-${d}`, role, divisionId: div[d as (typeof TEMPLATES)[number]].id, can: () => false });
    const oven = await boronganScope(prisma, mk("KAPTEN_DIVISI", "PRODUKSI") as never);
    const cetak = await boronganScope(prisma, mk("OPERATOR", "CETAK") as never);
    const packing = await boronganScope(prisma, mk("OPERATOR", "PACKING") as never);
    const asm = await boronganScope(prisma, mk("KAPTEN_DIVISI", "ASSEMBLING") as never);
    expect(canInputKering(oven), "Oven mengisi patung kering").toBe(true);
    expect(canInputKering(cetak), "Cetak mengisi patung kering").toBe(true);
    expect(canShip(oven), "Oven tidak mengirim bahan").toBe(false);
    expect(canReceive(packing, [{ name: "Assembling Cowok", divisionId: null }]), "Packing menerima setoran Assembling").toBe(true);
    expect(canCompleteAssembling(asm) || canShip(asm), "Kapten Assembling mengurus kiriman").toBe(true);
  });
});
