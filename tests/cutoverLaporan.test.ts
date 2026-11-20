import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { applyReportCutover, planReportCutover, startAfterCutover } from "@/lib/cutoverLaporan";
import { CUTOVER_SETTING, FLOW_SETTING, flowEnabledOn } from "@/lib/shiftReportFlow";
import { locationSettings, qtyAt } from "@/lib/stock";
import { RESULT_KEY } from "@/lib/shiftResultCount";
import { dateOnly } from "@/lib/time";

class Rollback extends Error {}
const tag = Date.now().toString(36).slice(-5).toUpperCase();
const DAY = "2025-03-15";
const actor = { id: "uji", name: "Uji cut-over" };
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 60000 }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
}

async function scenario(tx: Prisma.TransactionClient) {
  const locs = await locationSettings(tx);
  const div = await tx.division.findFirstOrThrow({ where: { reportTemplate: "ASSEMBLING" } });
  const [s1, s2] = await Promise.all([tx.shift.findUniqueOrThrow({ where: { code: "S1" } }), tx.shift.findUniqueOrThrow({ where: { code: "S2" } })]);
  const mk = (n: string, type: "BAHAN_BAKU" | "BARANG_DALAM_PROSES" | "BARANG_JADI", avg: number) => tx.item.create({ data: { sku: `CO-${n}-${tag}`, name: `Cutover ${n} ${tag}`, unit: "pcs", type, avgCost: BigInt(avg) } });
  const raw = await mk("BB", "BAHAN_BAKU", 100);
  const wip = await mk("SJ", "BARANG_DALAM_PROSES", 500);
  const fin = await mk("BJ", "BARANG_JADI", 1000);
  const none = await mk("TAK", "BAHAN_BAKU", 100);
  // Stok sistem sebelum: bahan 30 (diterima 14 Jan), barang jadi 8
  await tx.stockMovement.create({ data: { type: "PENERIMAAN", itemId: raw.id, toLocationId: locs.raw!, qty: 30, createdBy: "t", date: new Date("2025-03-14T03:00:00Z") } });
  await tx.stockMovement.create({ data: { type: "HASIL_PRODUKSI", itemId: fin.id, toLocationId: locs.finished!, qty: 8, createdBy: "t", date: new Date("2025-03-14T03:00:00Z") } });
  const base = { date: dateOnly(DAY), divisionId: div.id, createdBy: "uji", status: "TERKIRIM" as const };
  // Shift 1 menghitung bahan 50; Shift 2 (lebih akhir) bahan 40 + setengah jadi 20 + barang jadi 5 → yang dipakai Shift 2
  await tx.shiftReport.create({ data: { ...base, shiftId: s1.id, stockCount: [{ itemId: raw.id, name: raw.name, unit: "pcs", limit: 0, qty: 50 }] } });
  await tx.shiftReport.create({ data: { ...base, shiftId: s2.id, stockCount: [{ itemId: raw.id, name: raw.name, unit: "pcs", limit: 0, qty: 40 }], work: { [RESULT_KEY]: { [wip.id]: 20, [fin.id]: 5 } } } });
  // Mutasi sesudah cut-over (hari berikutnya) tetap: bahan keluar 5
  await tx.stockMovement.create({ data: { type: "PENGELUARAN", itemId: raw.id, fromLocationId: locs.raw!, qty: 5, createdBy: "t", date: new Date("2025-03-16T03:00:00Z") } });
  await tx.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
  return { locs, raw, wip, fin, none };
}

describe("stok:cutover-laporan", () => {
  it("tanggal mulai stok terpadu sesudah cut-over = hari berikutnya (bawaan)", () => {
    expect(startAfterCutover("2026-11-20")).toBe("2026-11-21");
    expect(startAfterCutover("2026-11-30")).toBe("2026-12-01");
    expect(startAfterCutover("2026-11-20", true)).toBe("2026-11-20");
  });

  it("pratinjau: stok sistem → laporan (shift terakhir), selisih qty & nilai, barang tidak dihitung, laporan belum terkirim", async () => {
    await inRollback(async (tx) => {
      const { raw, wip, fin, none } = await scenario(tx);
      const p = await planReportCutover(tx, DAY);
      const row = (id: string) => p.rows.find((r) => r.itemId === id)!;
      expect(row(raw.id)).toMatchObject({ system: 30, counted: 40, diff: 10, value: 1000 });
      expect(row(raw.id).source).toMatch(/Shift 2/);
      expect(row(raw.id).others.join()).toMatch(/Shift 1: 50/);
      expect(row(wip.id)).toMatchObject({ system: 0, counted: 20, diff: 20, value: 10000 });
      expect(row(fin.id)).toMatchObject({ system: 8, counted: 5, diff: -3, value: -3000 });
      expect(p.notCounted.some((i) => i.sku === none.sku)).toBe(true);
      expect(p.delta).toEqual({ BAHAN_BAKU: 1000, BARANG_DALAM_PROSES: 10000, BARANG_JADI: -3000 });
      expect(p.unsent.length).toBeGreaterThan(0); // divisi lain belum mengirim (tanpa --paksa ditolak oleh skrip)
    });
  });

  it("--jalankan: stok = hitungan laporan per lokasi (ref CUTOVER), jurnal ke Ekuitas Saldo Awal, setting tanggal mulai; mutasi sesudahnya tetap", async () => {
    await inRollback(async (tx) => {
      const { locs, raw, wip, fin, none } = await scenario(tx);
      const p = await planReportCutover(tx, DAY);
      const r = await applyReportCutover(tx, p, actor);
      expect(r.start).toBe("2025-03-16");
      expect(await qtyAt(tx, raw.id, locs.raw!, new Date("2025-03-15T23:59:00Z"))).toBe(40);
      expect(await qtyAt(tx, raw.id, locs.raw!)).toBe(35); // keluar 5 tanggal 16 tetap
      expect(await qtyAt(tx, wip.id, locs.wip!)).toBe(20);
      expect(await qtyAt(tx, fin.id, locs.finished!)).toBe(5);
      expect(await qtyAt(tx, none.id, locs.raw!)).toBe(0);
      const moves = await tx.stockMovement.findMany({ where: { ref: `CUTOVER-${DAY}`, itemId: { in: [raw.id, wip.id, fin.id] } } });
      expect(moves).toHaveLength(3);
      expect(moves.every((m) => m.type === "PENYESUAIAN" && m.journalId === null)).toBe(true);
      const j = await tx.journal.findFirstOrThrow({ where: { sourceId: `CUTOVER-${DAY}` }, include: { lines: { include: { account: true } } } });
      const sum = (k: "debit" | "credit") => j.lines.reduce((a, l) => a + Number(l[k]), 0);
      expect(sum("debit")).toBe(sum("credit"));
      expect(j.lines.some((l) => l.account.code === "3-9000")).toBe(true);
      expect((await tx.setting.findUniqueOrThrow({ where: { key: CUTOVER_SETTING } })).value).toBe("2025-03-16");
      // laporan tanggal cut-over tidak diposting lagi; laporan sesudahnya diposting normal dari saldo baru
      expect(await flowEnabledOn(DAY, tx)).toBe(false);
      expect(await flowEnabledOn("2025-03-16", tx)).toBe(true);
      expect(await tx.auditLog.count({ where: { action: "CUTOVER_LAPORAN_SHIFT" } })).toBeGreaterThan(0);
    });
  });
});
