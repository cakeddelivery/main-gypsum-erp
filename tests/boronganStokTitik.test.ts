import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { recordMovement } from "@/lib/stock";
import { correctPointStock, isLow, pointStock, reportMaterialReject, requestPointMaterials, weekStart } from "@/lib/boronganPointStock";
import { isCoordinatorOf } from "@/lib/boronganFlow";
import { FieldError } from "@/lib/fieldError";
import type { Scope } from "@/lib/borongan";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0, users: 0 })) }));
import { sendPush } from "@/lib/push";

const tag = `ST${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
let ctx: { pA: string; pB: string; locA: string; locB: string; item: string };

beforeAll(async () => {
  const [locA, locB, src] = await Promise.all([
    prisma.location.create({ data: { code: `${tag}A`, name: `Titik A ${tag}` } }),
    prisma.location.create({ data: { code: `${tag}B`, name: `Titik B ${tag}` } }),
    prisma.location.create({ data: { code: `${tag}G`, name: `Gudang ${tag}` } }),
  ]);
  const [pA, pB] = await Promise.all([
    prisma.boronganPoint.create({ data: { code: `${tag}A`, name: `Titik A ${tag}`, locationId: locA.id } }),
    prisma.boronganPoint.create({ data: { code: `${tag}B`, name: `Titik B ${tag}`, locationId: locB.id } }),
  ]);
  const item = await prisma.item.create({ data: { sku: `${tag}-OPP`, name: `Plastik OPP ${tag}`, unit: "pcs", type: "BAHAN_BAKU" } });
  await prisma.$transaction(async (tx) => {
    await recordMovement(tx, { type: "PENERIMAAN", itemId: item.id, qty: 100, toLocationId: src.id, unitCost: 10, ref: `TES:${tag}` }, actor);
    await recordMovement(tx, { type: "TRANSFER", itemId: item.id, qty: 40, fromLocationId: src.id, toLocationId: locA.id, ref: `KRM:${tag}` }, actor);
    await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: item.id, qty: 30, fromLocationId: locA.id, ref: `HSB:${tag}` }, actor);
  });
  ctx = { pA: pA.id, pB: pB.id, locA: locA.id, locB: locB.id, item: item.id };
});

afterAll(async () => {
  await prisma.boronganPoint.updateMany({ where: { id: { in: [ctx.pA, ctx.pB] } }, data: { active: false } });
});

describe("Stok bahan di titik borongan", () => {
  it("tipis bila kurang dari pemakaian minggu ini atau habis", () => {
    expect(isLow(5, 10)).toBe(true);
    expect(isLow(0, 0)).toBe(true);
    expect(isLow(0, 0, false)).toBe(false); // belum pernah ada di titik: bukan peringatan
    expect(isLow(20, 10)).toBe(false);
    const w = weekStart(new Date("2026-11-18T05:00:00Z")); // Rabu
    expect(w.toISOString()).toBe("2026-11-15T17:00:00.000Z"); // Senin 16 Nov 00:00 WIB
  });

  it("stok, masuk & terpakai dari mutasi stok titik; titik lain terpisah", async () => {
    const a = (await pointStock(ctx.pA)).find((r) => r.itemId === ctx.item)!;
    expect([a.stock, a.inWeek, a.usedWeek, a.low]).toEqual([10, 40, 30, true]);
    expect((await pointStock(ctx.pB)).find((r) => r.itemId === ctx.item && r.stock !== 0)).toBeUndefined();
  });

  it("koreksi/opname titik dengan alasan → mutasi penyesuaian + audit", async () => {
    await expect(correctPointStock(ctx.pA, ctx.item, 12, "", actor)).rejects.toBeInstanceOf(FieldError);
    const r = await correctPointStock(ctx.pA, ctx.item, 12, "hitung ulang", actor);
    expect(r).toEqual({ before: 10, counted: 12, diff: 2 });
    expect((await pointStock(ctx.pA)).find((x) => x.itemId === ctx.item)!.stock).toBe(12);
    expect(await prisma.auditLog.count({ where: { action: "KOREKSI_STOK_TITIK", entityId: ctx.pA } })).toBe(1);
  });

  it("minta bahan → push Supervisor/Assembling; hanya koordinator titik sendiri", async () => {
    vi.mocked(sendPush).mockClear();
    const r = await requestPointMaterials(ctx.pA, [ctx.item], "untuk Kamis", actor);
    expect(r.count).toBe(1);
    const coordA: Scope = { all: false, pointIds: [ctx.pA], personId: "k", taskIds: null };
    expect(isCoordinatorOf(coordA, ctx.pA)).toBe(true);
    expect(isCoordinatorOf(coordA, ctx.pB)).toBe(false);
  });

  it("reject bahan titik (cat cair, plastik klip, OPP): stok berkurang, tercatat per alasan, audit; hitung fisik terakhir & penanda belum dihitung", async () => {
    const before = (await pointStock(ctx.pA)).find((x) => x.itemId === ctx.item)!;
    expect(before.lastCounted).not.toBeNull(); // sudah dikoreksi/dihitung di tes sebelumnya
    expect(before.stale).toBe(false);
    await expect(reportMaterialReject(ctx.pA, ctx.item, 0, "ROBEK", null, actor)).rejects.toBeInstanceOf(FieldError);
    await expect(reportMaterialReject(ctx.pA, ctx.item, 2, "", null, actor)).rejects.toBeInstanceOf(FieldError);
    await expect(reportMaterialReject(ctx.pB, ctx.item, 2, "ROBEK", null, actor)).rejects.toBeInstanceOf(FieldError); // bukan bahan titik B
    await reportMaterialReject(ctx.pA, ctx.item, 2, "ROBEK", "OPP robek saat dibungkus", actor);
    const after = (await pointStock(ctx.pA)).find((x) => x.itemId === ctx.item)!;
    expect([after.stock, after.rejectWeek]).toEqual([before.stock - 2, 2]);
    expect(await prisma.boronganMaterialReject.count({ where: { pointId: ctx.pA, itemId: ctx.item, reason: "ROBEK" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "REJECT_BAHAN_TITIK", entityId: ctx.pA } })).toBe(1);
  });
});
