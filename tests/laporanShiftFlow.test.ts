import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { COA } from "@/lib/accounting";
import { locationSettings, qtyAt, usageAccountCode } from "@/lib/stock";
import { flowLines, parseWork, plannedFlow, splitEven, summaryOf, targetLine, targetOf, workLines, type WorkData } from "@/lib/shiftReport";
import { FLOW_SETTING, flowItem, postShiftWork } from "@/lib/shiftReportFlow";
import { recordProductionEntry } from "@/lib/productionEntry";
import { dateOnly, jakartaDateTime } from "@/lib/time";

describe("Rencana stok dari hasil kerja (murni)", () => {
  it("Produksi: panen dua oven → patung kering per varian", () => {
    const work: WorkData = { panen: [{ name: "Oven Besar", v: [300, 300, 700, 300] }, { name: "Oven Kecil", v: [null, null, null, 700] }] };
    expect(plannedFlow("PRODUKSI", work)).toEqual([
      { kind: "kering", key: "Hewan", qty: 300, dir: "in" },
      { kind: "kering", key: "Cowok", qty: 300, dir: "in" },
      { kind: "kering", key: "Transportasi", qty: 700, dir: "in" },
      { kind: "kering", key: "Cewek", qty: 1000, dir: "in" },
    ]);
  });
  it("Assembling: patung kering keluar, produk jadi masuk", () => {
    const steps = plannedFlow("ASSEMBLING", { jadi: [{ name: "Eva", v: [10, null, 5, null] }, { name: "Sonna", v: [2, 3, null, null] }] });
    expect(flowLines(steps)).toEqual(["+ Produk jadi Hewan 12", "+ Produk jadi Cowok 3", "+ Produk jadi Transportasi 5", "− Patung kering Hewan 12", "− Patung kering Cowok 3", "− Patung kering Transportasi 5"]);
  });
  it("Giftbox: 5 patung kering per box (MIX dibagi rata), giftbox masuk lalu keluar", () => {
    const steps = plannedFlow("GIFTBOX", { giftbox: { MIX: 2, CEW: 1, "HWN-PLT": 1 } });
    expect(splitEven(10)).toEqual({ Hewan: 3, Cowok: 3, Transportasi: 2, Cewek: 2 });
    const out = steps.filter((s) => s.kind === "kering");
    expect(Object.fromEntries(out.map((s) => [s.key, s.qty]))).toEqual({ Hewan: 3 + 5, Cowok: 3, Transportasi: 2, Cewek: 2 + 5 });
    expect(steps.filter((s) => s.kind === "giftbox" && s.dir === "in").map((s) => [s.key, s.qty])).toEqual([["MIX", 2], ["CEW", 1], ["HWN-PLT", 1]]);
    expect(steps.filter((s) => s.kind === "giftbox" && s.dir === "out")).toHaveLength(3);
  });
  it("Packing: satuan + paket mix dibagi rata per varian keluar dari produk jadi", () => {
    const steps = plannedFlow("PACKING", { satuan: { cowok: 22, cewek: 23, transportasi: 200, hewan: 171 }, mix: { p12: 5, p24: 17, p48: 9, p96: 1 } });
    const q = Object.fromEntries(steps.map((s) => [s.key, s.qty]));
    // mix 996 pcs = 249 per varian
    expect(q).toEqual({ Hewan: 171 + 249, Cowok: 22 + 249, Transportasi: 200 + 249, Cewek: 23 + 249 });
    expect(steps.every((s) => s.kind === "jadi" && s.dir === "out")).toBe(true);
  });
  it("reject panen + alasan; target & capaian", () => {
    const fd: Record<string, string> = { "w.reject.0.1": "40", "w.rejectReason": "Pecah / retak", "w.panen.0.0": "1000", "w.panen.1.3": "1000" };
    const work = parseWork("PRODUKSI", (k) => fd[k] ?? null);
    expect(summaryOf("PRODUKSI", work).map((s) => [s.label, s.value])).toEqual([["Total panen", 2000], ["Total reject", 40], ["Total hasil cetak", 0]]);
    expect(workLines("PRODUKSI", work)).toContain("ALASAN REJECT: Pecah / retak");
    expect(() => parseWork("PRODUKSI", (k) => ({ "w.rejectReason": "ngawur" })[k] ?? null)).toThrow(/Alasan reject/);
    // Reject kosong tidak tampil
    expect(workLines("PRODUKSI", { panen: [] }).some((l) => l.startsWith("REJECT"))).toBe(false);
    const t = targetOf("PRODUKSI", work, 2400)!;
    expect(t).toMatchObject({ value: 2000, pct: 83, reached: false });
    expect(targetLine(t)).toBe("Target panen 2.400 pcs · hasil 2.000 (83%) ⚠ di bawah target");
    expect(targetOf("PRODUKSI", work, null)).toBeNull();
  });
});

describe("Posting hasil kerja laporan shift ke stok", () => {
  let actor: { id: string; name: string };
  let s1: string;
  let wip: string;
  let finished: string;
  const div = (t: string) => prisma.division.findFirstOrThrow({ where: { reportTemplate: t } });
  const report = async (template: string, date: string, work: WorkData) =>
    prisma.shiftReport.create({ data: { date: dateOnly(date), shiftId: s1, divisionId: (await div(template)).id, createdBy: "uji", work } });

  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
    const l = await locationSettings(prisma);
    wip = l.wip!;
    finished = l.finished!;
  });

  it("nonaktif: tidak mengubah stok", async () => {
    const r = await report("PRODUKSI", "2027-10-01", { panen: [{ name: "Oven Besar", v: [5, 0, 0, 0] }] });
    expect(await postShiftWork(r.id, actor)).toEqual({ posted: 0, skipped: "nonaktif" });
  });

  it("aktif: panen → patung kering; assembling → produk jadi bernilai resep; packing → HPP; revisi membalik versi lama", async () => {
    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    const kering = await prisma.$transaction((tx) => flowItem(tx, { kind: "kering", key: "Hewan" }));
    const jadi = await prisma.$transaction((tx) => flowItem(tx, { kind: "jadi", key: "Hewan" }));
    const k0 = await qtyAt(prisma, kering, wip);
    const j0 = await qtyAt(prisma, jadi, finished);

    const panen = await report("PRODUKSI", "2027-10-02", { panen: [{ name: "Oven Besar", v: [300, null, null, null] }, { name: "Oven Kecil", v: [100, null, null, null] }] });
    expect((await postShiftWork(panen.id, actor, jakartaDateTime("2027-10-03", "08:00"))).posted).toBe(1);
    expect(await qtyAt(prisma, kering, wip)).toBe(k0 + 400);
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { ref: `LPH:${panen.id}:1` } });
    expect(mv.date.toISOString()).toBe(jakartaDateTime("2027-10-02", "15:00").toISOString());

    const asm = await report("ASSEMBLING", "2027-10-02", { jadi: [{ name: "Eva", v: [100, null, null, null] }] });
    await postShiftWork(asm.id, actor, jakartaDateTime("2027-10-03", "08:00"));
    expect(await qtyAt(prisma, kering, wip)).toBe(k0 + 300);
    expect(await qtyAt(prisma, jadi, finished)).toBe(j0 + 100);
    // Nilai bahan resep pindah dari HPP Pemakaian Bahan Baku ke persediaan barang jadi
    const j = await prisma.journal.findFirst({ where: { source: "LAPORAN_SHIFT", sourceId: `${asm.id}:1` }, include: { lines: { include: { account: true } } } });
    expect(j).toBeTruthy();
    if (j) {
      expect(j.lines.find((l) => l.account.code === COA.PERSEDIAAN_JADI)?.debit).toBeGreaterThan(0n);
      expect(j.lines.find((l) => Number(l.credit) > 0)?.account.code).toBe(await usageAccountCode(prisma));
    }

    // Revisi: 100 → 80; versi lama dibalik (stok & jurnal), versi baru diposting
    await prisma.shiftReport.update({ where: { id: asm.id }, data: { work: { jadi: [{ name: "Eva", v: [80, null, null, null] }] } } });
    await postShiftWork(asm.id, actor, jakartaDateTime("2027-10-03", "09:00"));
    expect(await qtyAt(prisma, jadi, finished)).toBe(j0 + 80);
    expect(await qtyAt(prisma, kering, wip)).toBe(k0 + 320);
    expect((await prisma.shiftReport.findUniqueOrThrow({ where: { id: asm.id } })).workPostedVersion).toBe(2);
    if (j) expect(await prisma.journal.count({ where: { reversalOfId: j.id } })).toBe(1);

    // Packing: produk jadi keluar → HPP (Dr HPP / Cr Persediaan Barang Jadi)
    const pck = await report("PACKING", "2027-10-02", { satuan: { hewan: 30 } });
    await postShiftWork(pck.id, actor, jakartaDateTime("2027-10-03", "10:00"));
    expect(await qtyAt(prisma, jadi, finished)).toBe(j0 + 50);
    const out = await prisma.stockMovement.findFirstOrThrow({ where: { ref: `LPH:${pck.id}:1`, type: "PENGELUARAN" } });
    expect(out.journalId).toBeTruthy();
    if (out.journalId) {
      const ls = await prisma.journalLine.findMany({ where: { journalId: out.journalId }, include: { account: true } });
      expect(ls.find((l) => l.account.code === COA.HPP)?.debit).toBeGreaterThan(0n);
    }
  });

  it("input manual tahap yang sama di menu Produksi hanya untuk Owner saat aktif", async () => {
    const d = await div("ASSEMBLING");
    const emp = await prisma.employee.findFirstOrThrow({ where: { status: { not: "NONAKTIF" } } });
    const product = await prisma.product.findFirstOrThrow();
    const input = { date: "2027-10-04", shiftId: s1, divisionId: d.id, employeeId: emp.id, stage: "ASSEMBLING", productId: product.id, qtyGood: 1, qtyReject: 0, rejectReason: null };
    await expect(recordProductionEntry(input, { id: actor.id, name: "Admin", role: "ADMIN", employeeId: null, divisionId: null })).rejects.toThrow(/Laporan Shift/);
    // Tahap lain tetap boleh
    await expect(recordProductionEntry({ ...input, stage: "FILLING_CAT" }, { id: actor.id, name: "Admin", role: "ADMIN", employeeId: null, divisionId: null })).resolves.toBeTruthy();
    await prisma.setting.update({ where: { key: FLOW_SETTING }, data: { value: "false" } });
  });
});
