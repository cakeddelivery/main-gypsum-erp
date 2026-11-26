import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { locationSettings, qtyAt } from "@/lib/stock";
import { plannedFlow } from "@/lib/shiftReport";
import { FLOW_SETTING, flowItem, postShiftWork } from "@/lib/shiftReportFlow";
import { addHarvest, cancelHarvest, correctHarvest, harvestGrids, netOfHarvest } from "@/lib/shiftHarvest";
import { DEFAULT_MATRIX, effectivePermissions } from "@/lib/rbac";
import { dateOnly, jakartaDateTime } from "@/lib/time";

describe("Panen realtime (murni)", () => {
  it("grid dari entri aktif; rencana stok dikurangi yang sudah diposting", () => {
    const e = [
      { oven: "Oven Besar", variant: "Cewek", good: 100, reject: 5, posted: true, cancelledAt: null },
      { oven: "Oven Kecil", variant: "Cewek", good: 50, reject: 0, posted: true, cancelledAt: null },
      { oven: "Oven Besar", variant: "Hewan", good: 30, reject: 0, posted: true, cancelledAt: new Date() },
    ];
    const g = harvestGrids(e);
    expect(g.panen).toEqual([{ name: "Oven Besar", v: [null, null, null, 100] }, { name: "Oven Kecil", v: [null, null, null, 50] }]);
    expect(g.reject).toEqual([{ name: "Oven Besar", v: [null, null, null, 5] }]);
    // Isian laporan = entri → tidak ada selisih yang diposting lagi; hasil cetak tetap diposting
    const steps = plannedFlow("PRODUKSI", { ...g, cetakSeries: [{ name: "Ani", v: [10, null, null, null] }] });
    expect(netOfHarvest(steps, e)).toEqual([{ kind: "basah", key: "Hewan", qty: 10, dir: "in" }]);
  });
});

describe("Hak akses report.harvest", () => {
  it("bawaan: anggota Oven (Operator/Kapten), Supervisor, Admin, Owner; bisa dicabut lewat Pengaturan peran", () => {
    for (const r of ["OPERATOR", "KAPTEN_DIVISI", "SUPERVISOR", "ADMIN", "ADMIN_PRODUKSI"] as const) expect(DEFAULT_MATRIX[r]).toContain("report.harvest");
    expect(effectivePermissions("OWNER", []).has("report.harvest")).toBe(true);
    expect(effectivePermissions("DRIVER", []).has("report.harvest")).toBe(false);
    expect(effectivePermissions("OPERATOR", [{ role: "OPERATOR", permission: "report.harvest", allowed: false }]).has("report.harvest")).toBe(false);
  });
});

describe("Panen realtime → stok", () => {
  let owner: { id: string; name: string; role: string };
  let other: { id: string; name: string; role: string };
  let s1: string;
  let wip: string;
  let kering: string;
  let basah: string;
  const mkReport = async (date: string) => {
    const d = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PRODUKSI" } });
    return prisma.shiftReport.create({ data: { date: dateOnly(date), shiftId: s1, divisionId: d.id, createdBy: "uji" } });
  };

  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    owner = { id: u.id, name: u.name, role: "OWNER" };
    other = { id: "uji-operator", name: "Operator Oven", role: "OPERATOR" };
    s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
    wip = (await locationSettings(prisma)).wip!;
    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    kering = await prisma.$transaction((tx) => flowItem(tx, { kind: "kering", key: "Cewek" }));
    basah = await prisma.$transaction((tx) => flowItem(tx, { kind: "basah", key: "Cewek" }));
  });
  afterAll(async () => {
    await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: "false" } });
  });

  it("entri langsung masuk stok bertanggal jam entri; kirim laporan tidak dobel; revisi tetap konsisten", async () => {
    const r = await mkReport("2027-11-02");
    const k0 = await qtyAt(prisma, kering, wip);
    const b0 = await qtyAt(prisma, basah, wip);
    const at = jakartaDateTime("2027-11-02", "10:15");
    const res = await addHarvest(r.id, { oven: "Oven Besar", lines: [{ variant: "Cewek", good: 200, reject: 10 }] }, other, at);
    expect(res.posted).toBe(1);
    expect(await qtyAt(prisma, kering, wip)).toBe(k0 + 200);
    expect(await qtyAt(prisma, basah, wip)).toBe(b0 - 210);
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { ref: `PNN:${res.ids[0]}`, itemId: kering } });
    expect(mv.date.toISOString()).toBe(at.toISOString());
    await addHarvest(r.id, { oven: "Oven Kecil", lines: [{ variant: "Cewek", good: 50, reject: 0 }] }, other, jakartaDateTime("2027-11-02", "12:00"));
    const w = (await prisma.shiftReport.findUniqueOrThrow({ where: { id: r.id } })).work as Record<string, unknown>;
    expect(w.panen).toEqual([{ name: "Oven Besar", v: [null, null, null, 200] }, { name: "Oven Kecil", v: [null, null, null, 50] }]);

    // Kirim laporan (dengan hasil cetak): panen tidak diposting lagi
    await prisma.shiftReport.update({ where: { id: r.id }, data: { work: { ...w, cetakSeries: [{ name: "Ani", v: [null, null, null, 40] }] } } });
    await postShiftWork(r.id, owner, jakartaDateTime("2027-11-02", "16:00"));
    expect(await qtyAt(prisma, kering, wip)).toBe(k0 + 250);
    expect(await qtyAt(prisma, basah, wip)).toBe(b0 - 260 + 40);
    // Revisi (kirim ulang) tetap sama
    await postShiftWork(r.id, owner, jakartaDateTime("2027-11-02", "17:00"));
    expect(await qtyAt(prisma, kering, wip)).toBe(k0 + 250);
    expect(await qtyAt(prisma, basah, wip)).toBe(b0 - 260 + 40);
  });

  it("koreksi/batal: pembuat sebelum dikirim; sesudahnya hanya Owner/Supervisor + alasan", async () => {
    const r = await mkReport("2027-11-03");
    const k0 = await qtyAt(prisma, kering, wip);
    const { ids } = await addHarvest(r.id, { oven: "Oven Besar", lines: [{ variant: "Cewek", good: 100, reject: 0 }] }, other);
    await expect(cancelHarvest(ids[0], null, { id: "orang-lain", name: "Lain", role: "OPERATOR" })).rejects.toThrow(/pembuat/);
    const c = await correctHarvest(ids[0], { good: 80, reject: 5 }, null, other);
    expect(await qtyAt(prisma, kering, wip)).toBe(k0 + 80);
    const old = await prisma.shiftHarvest.findUniqueOrThrow({ where: { id: ids[0] } });
    expect(old.cancelledAt).toBeTruthy(); // tidak dihapus
    expect(await prisma.stockMovement.count({ where: { ref: `BATAL-PNN:${ids[0]}` } })).toBe(2);

    // Laporan dikirim → operator tidak bisa; Owner wajib alasan
    await postShiftWork(r.id, owner);
    await prisma.shiftReport.update({ where: { id: r.id }, data: { status: "TERKIRIM" } });
    await expect(addHarvest(r.id, { oven: "Oven Besar", lines: [{ variant: "Cewek", good: 1, reject: 0 }] }, other)).rejects.toThrow(/sudah dikirim/);
    await expect(cancelHarvest(c.newId, "salah", other)).rejects.toThrow(/Owner\/Supervisor/);
    await expect(cancelHarvest(c.newId, "", owner)).rejects.toThrow(/Alasan/);
    await cancelHarvest(c.newId, "dobel input", owner);
    expect(await qtyAt(prisma, kering, wip)).toBe(k0);
    const w = (await prisma.shiftReport.findUniqueOrThrow({ where: { id: r.id } })).work as Record<string, unknown>;
    expect(w.panen).toEqual([]);
  });
});
