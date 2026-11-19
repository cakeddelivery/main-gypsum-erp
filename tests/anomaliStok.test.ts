import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { locationSettings, recordMovement } from "@/lib/stock";
import { detectAnomalies, openAnomalyCount, runStockAlerts } from "@/lib/stockAlerts";
import { addDays, dateOnly, jakartaDateTime, todayStr } from "@/lib/time";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 1, removed: 0, failed: 0, users: 1 })) }));
import { sendPush } from "@/lib/push";

const tag = Date.now().toString(36).slice(-5).toUpperCase();

describe("Alert anomali stok & produksi", () => {
  it("barang tidak bergerak, prakiraan habis, selisih neraca, stok minus; dedupe, push TINGGI, status dijelaskan dipertahankan", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const actor = { id: u.id, name: u.name };
    const { wip, raw } = await locationSettings(prisma);
    const div = await prisma.division.create({ data: { code: `AN${tag}`, name: `Div Alert ${tag}`, shiftCount: 1, reportTemplate: "CETAK" } });
    const mk = (sku: string, type: "BAHAN_BAKU" | "BARANG_DALAM_PROSES", avg = 1000) => prisma.item.create({ data: { sku: `${sku}-${tag}`, name: `${sku} ${tag}`, type, unit: "pcs", avgCost: avg, divisionId: div.id } });
    const diam = await mk("DIAM", "BARANG_DALAM_PROSES");
    const habis = await mk("HABIS", "BAHAN_BAKU");
    const minus = await mk("MINUS", "BAHAN_BAKU");
    const old = jakartaDateTime(addDays(todayStr(), -20), "10:00");
    const recent = jakartaDateTime(addDays(todayStr(), -1), "10:00");
    await prisma.$transaction(async (tx) => {
      // setengah jadi: ada stok, keluar terakhir 20 hari lalu (> 14 hari)
      await recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: diam.id, qty: 500, toLocationId: wip!, unitCost: 1000, date: old }, actor);
      await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: diam.id, qty: 10, fromLocationId: wip!, date: old }, actor);
      // bahan: stok 20, dipakai 10 per hari selama 14 hari terakhir → habis ±0 hari… stok 20 vs 10/hari = 2 hari
      await recordMovement(tx, { type: "PENERIMAAN", itemId: habis.id, qty: 160, toLocationId: raw!, unitCost: 1000, date: jakartaDateTime(addDays(todayStr(), -13), "08:00") }, actor);
      for (let d = 1; d <= 14; d++) await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: habis.id, qty: 10, fromLocationId: raw!, date: jakartaDateTime(addDays(todayStr(), -d), "09:00"), allowNegative: true }, actor);
      // stok minus
      await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: minus.id, qty: 5, fromLocationId: raw!, date: recent, allowNegative: true }, actor);
    });
    // Neraca: fisik 1700 vs sistem 2000 (selisih besar 15%)
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    const rep = await prisma.shiftReport.create({ data: { date: dateOnly(addDays(todayStr(), -1)), shiftId: shift.id, divisionId: div.id, status: "TERKIRIM", createdBy: "t", picName: "p" } });
    await prisma.shiftBalance.create({ data: { reportId: rep.id, divisionId: div.id, itemId: diam.id, opening: 2000, systemClosing: 2000, counted: 1700, diff: -300, unitCost: 1000 } });

    const found = (await detectAnomalies()).filter((x) => [diam.id, habis.id, minus.id].includes(x.itemId ?? ""));
    const by = (type: string, id: string) => found.find((x) => x.type === type && x.itemId === id);
    expect(by("BARANG_DIAM", diam.id)).toBeTruthy();
    expect(by("PRAKIRAAN_HABIS", habis.id)?.severity).toBe("TINGGI"); // < 3 hari
    expect(by("STOK_MINUS", minus.id)?.severity).toBe("TINGGI");
    const sel = by("NERACA_SELISIH", diam.id)!;
    expect([sel.severity, sel.value]).toEqual(["TINGGI", 300_000]);

    vi.mocked(sendPush).mockClear();
    const r1 = await runStockAlerts();
    expect(r1.created).toBeGreaterThanOrEqual(4);
    expect(vi.mocked(sendPush)).toHaveBeenCalledTimes(1);
    expect(await prisma.stockAnomaly.count({ where: { itemId: { in: [diam.id, habis.id, minus.id] } } })).toBeGreaterThanOrEqual(4);
    // Dedupe + tidak push ulang
    const r2 = await runStockAlerts();
    expect(r2.created).toBe(0);
    expect(vi.mocked(sendPush)).toHaveBeenCalledTimes(1);
    // Penjelasan dipertahankan
    const a = await prisma.stockAnomaly.findFirstOrThrow({ where: { itemId: minus.id, type: "STOK_MINUS" } });
    await prisma.stockAnomaly.update({ where: { id: a.id }, data: { status: "DIJELASKAN", note: "sudah dicatat masuk", noteBy: "Owner" } });
    await runStockAlerts();
    expect((await prisma.stockAnomaly.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("DIJELASKAN");
    expect(await openAnomalyCount()).toBeGreaterThan(0);
  });
});
