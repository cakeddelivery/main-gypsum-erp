import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { boronganScope, savePerson, type Scope } from "@/lib/borongan";
import { createShipment, forCoordinator, receiveByColor, saveWorkReport, shipmentView } from "@/lib/boronganFlow";
import { pointWageSummary } from "@/lib/boronganClaim";
import { saveItemRecord } from "@/lib/items";
import { saveTaskKit } from "@/lib/boronganSetup";
import { stockBalances } from "@/lib/stock";

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPush: vi.fn(async () => ({ sent: 0, removed: 0, failed: 0, users: 0 })) }));
import { sendPush } from "@/lib/push";

const all: Scope = { all: true, owner: true, backup: true, pointIds: [], personId: null, taskIds: null };
const tag = Date.now().toString(36).slice(-4).toUpperCase();
const at = async (itemId: string, locationId: string) => (await stockBalances(prisma, itemId)).find((b) => b.locationId === locationId)?.qty ?? 0;

describe("Cat Plastik Beringin: kirim bahan tanpa jumlah → lapor Mita → terima per warna → selisih → upah dari yang diterima", () => {
  let actor: { id: string; name: string };
  const ctx = {} as { point: { id: string; locationId: string }; merah: string; biru: string; lain: string; cat: string; outMerah: string; outBiru: string; mita: { id: string; name: string }; mitaScope: Scope; wA: string; wB: string; div: string };
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
    const div = await prisma.division.create({ data: { code: `HT${tag}`, name: `Penerima ${tag}` } });
    const loc = await prisma.location.create({ data: { code: `LHT${tag}`, name: `Beringin uji ${tag}` } });
    const point = await prisma.boronganPoint.create({ data: { code: `HT${tag}`, name: `Beringin uji ${tag}`, locationId: loc.id, viaDriver: false, noCoordinator: true } });
    const item = (name: string, type: "BAHAN_BAKU" | "BARANG_DALAM_PROSES", openingQty = 0) => saveItemRecord({ name: `${name} ${tag}`, type, category: type === "BAHAN_BAKU" ? "Bahan Pendukung" : "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty }, actor);
    const cat = await item("Cat uji", "BAHAN_BAKU", 50);
    const outMerah = await item("CP Merah", "BARANG_DALAM_PROSES");
    const outBiru = await item("CP Biru", "BARANG_DALAM_PROSES");
    const mk = (color: string, out: string, flag = true) => prisma.pieceTask.create({ data: { code: `HT${color.slice(0, 2)}${tag}`.toUpperCase(), name: `Cat plastik ${tag} ${color}`, divisionId: div.id, ratePerPcs: 15n, workerRate: 13n, coordinatorRate: 2n, driverRate: 0n, outputItemId: out, resultAtReceipt: flag } });
    const merah = await mk("merah", outMerah.id);
    const biru = await mk("biru", outBiru.id);
    const lain = await prisma.pieceTask.create({ data: { code: `HTL${tag}`, name: `Rakit lain ${tag}`, divisionId: div.id, ratePerPcs: 10n, workerRate: 10n, coordinatorRate: 0n, driverRate: 0n } });
    await saveTaskKit(prisma, merah.id, [cat.id]);
    await saveTaskKit(prisma, biru.id, [cat.id]);
    const user = await prisma.user.create({ data: { username: `mitaht${tag.toLowerCase()}`, name: `Mita ${tag}`, passwordHash: "x", role: "KOORDINATOR" } });
    const mita = await savePerson({ name: `Mita ${tag}`, role: "KOORDINATOR", pointId: point.id }, actor, all);
    await prisma.boronganPerson.update({ where: { id: mita.id }, data: { userId: user.id } });
    const wA = await savePerson({ name: `Pekerja A ${tag}`, role: "PEKERJA", pointId: point.id }, actor, all);
    const wB = await savePerson({ name: `Pekerja B ${tag}`, role: "PEKERJA", pointId: point.id }, actor, all);
    Object.assign(ctx, { point, merah: merah.id, biru: biru.id, lain: lain.id, cat: cat.id, outMerah: outMerah.id, outBiru: outBiru.id, mita: { id: user.id, name: user.name }, mitaScope: await boronganScope(prisma, { id: user.id, can: () => false, role: "KOORDINATOR" }), wA: wA.id, wB: wB.id, div: div.id });
  });
  afterAll(async () => {
    await prisma.boronganPerson.updateMany({ where: { pointId: ctx.point.id }, data: { active: false } });
    await prisma.boronganPoint.update({ where: { id: ctx.point.id }, data: { active: false } });
    await prisma.pieceTask.updateMany({ where: { id: { in: [ctx.merah, ctx.biru, ctx.lain] } }, data: { active: false } });
  });

  let shipmentId = "";
  it("kirim: jumlah per jenis boleh kosong untuk tugas 'hasil diisi saat penerimaan'; bahan wajib; tugas biasa tetap wajib jumlah", async () => {
    const base = { date: "2026-11-22", mode: "LANGSUNG" as const, pointIds: [ctx.point.id] };
    await expect(createShipment({ ...base, tasks: [{ taskId: ctx.merah, qty: 0 }, { taskId: ctx.biru, qty: 0 }] }, actor, all)).rejects.toThrow(/Isi bahan yang dikirim/);
    await expect(createShipment({ ...base, tasks: [{ taskId: ctx.lain, qty: 0 }] }, actor, all)).rejects.toThrow(/Isi jumlah minimal satu jenis/);
    const s = await createShipment({ ...base, tasks: [{ taskId: ctx.merah, qty: 0 }, { taskId: ctx.biru, qty: 0 }], support: [{ itemId: ctx.cat, qty: 2 }] }, actor, all);
    shipmentId = s.id;
    expect(s.resultAtReceipt).toBe(true);
    expect(await at(ctx.cat, ctx.point.locationId)).toBe(2); // bahan keluar gudang ke titik saat kirim
    // Mita melihat kiriman titiknya walau belum ada pembagian
    const v = (await shipmentView(s.id))!;
    expect(forCoordinator(v, ctx.mitaScope.pointIds)).not.toBeNull();
  });

  it("Mita lapor hasil per pekerja (tanpa pembagian) → Assembling terima per warna → selisih, upah & stok dari yang diterima", async () => {
    await saveWorkReport(shipmentId, ctx.point.id, [
      { workerId: ctx.wA, taskId: ctx.merah, good: 60, reject: 2 },
      { workerId: ctx.wB, taskId: ctx.merah, good: 40, reject: 0 },
      { workerId: ctx.wA, taskId: ctx.biru, good: 30, reject: 0 },
    ], true, ctx.mita, ctx.mitaScope);
    // Terima tanpa laporan biru untuk B → tidak masalah; tanpa laporan sama sekali → ditolak (diuji lewat jenis kosong di bawah)
    vi.mocked(sendPush).mockClear();
    const r = await receiveByColor(shipmentId, ctx.point.id, [{ taskId: ctx.merah, qty: 98 }, { taskId: ctx.biru, qty: 30 }], actor, all);
    expect(r.mismatch).toBe(true);
    expect(r.note).toMatch(/merah diterima 98 \/ lapor 100 \(-2\)/i);
    expect(vi.mocked(sendPush).mock.calls.some(([ids]) => ids.includes(ctx.mita.id))).toBe(true);
    const pk = await prisma.boronganPickup.findFirstOrThrow({ where: { shipmentId }, include: { lines: true, results: true } });
    const q = (w: string, t: string) => pk.lines.find((l) => l.workerId === w && l.taskId === t)?.qty;
    // 98 dibagi 60:40 (sisa terbesar) → 59 / 39; biru 30 utuh ke A
    expect([q(ctx.wA, ctx.merah), q(ctx.wB, ctx.merah), q(ctx.wA, ctx.biru)]).toEqual([59, 39, 30]);
    expect(pk.results.every((x) => Number(x.workerRate) === 15 && !x.coordinatorId)).toBe(true); // tanpa fee koordinator (Beringin)
    // Stok hasil masuk gudang sebanyak yang diterima
    const wip = (await prisma.setting.findUniqueOrThrow({ where: { key: "loc_wip" } })).value;
    expect(await at(ctx.outMerah, wip)).toBe(98);
    expect(await at(ctx.outBiru, wip)).toBe(30);
    // Kroscek di tampilan & status selesai
    const v = (await shipmentView(shipmentId))!;
    expect(v.crosscheck?.find((c) => c.taskId === ctx.merah)).toMatchObject({ reported: 100, received: 98 });
    expect(v.state).toBe("SELESAI");
    // Upah yang bisa diklaim = yang diterima × Rp15, tanpa baris koordinator
    const w = await pointWageSummary(ctx.point.id);
    expect(w.breakdown.totals.all).toBe((98 + 30) * 15);
    expect(w.breakdown.coordinators).toEqual([]);
    await expect(receiveByColor(shipmentId, ctx.point.id, [{ taskId: ctx.merah, qty: 1 }, { taskId: ctx.biru, qty: 0 }], actor, all)).rejects.toThrow(/sudah diterima/);
  });

  it("tanpa jumlah pcs: bahan resep diisi manual (diizinkan), jumlah per jenis yang terkirim diabaikan (0), bahan ke titik", async () => {
    const mentah = await saveItemRecord({ name: `Patung mentah ${tag}`, type: "BAHAN_BAKU", category: "Bahan Pendukung", unit: "pcs", hppFactor: 1, minStock: 0, price: 100, openingQty: 20 }, actor);
    await prisma.pieceTaskInput.create({ data: { taskId: ctx.biru, itemId: mentah.id, qty: 1 } });
    const s = await createShipment({ date: "2026-11-22", mode: "LANGSUNG", pointIds: [ctx.point.id], tasks: [{ taskId: ctx.merah, qty: 50 }, { taskId: ctx.biru, qty: 0 }], support: [{ itemId: mentah.id, qty: 7 }] }, actor, all);
    const t = await prisma.boronganShipmentTask.findMany({ where: { shipmentId: s.id } });
    expect(t.every((x) => x.qty === 0)).toBe(true);
    expect(await at(mentah.id, ctx.point.locationId)).toBe(7);
    await prisma.boronganShipment.update({ where: { id: s.id }, data: { cancelledAt: new Date(), cancelledBy: "uji" } });
  });

  it("penerimaan ditolak bila koordinator belum lapor jenis yang diterima", async () => {
    const s = await createShipment({ date: "2026-11-22", mode: "LANGSUNG", pointIds: [ctx.point.id], tasks: [{ taskId: ctx.merah, qty: 0 }, { taskId: ctx.biru, qty: 0 }], support: [{ itemId: ctx.cat, qty: 1 }] }, actor, all);
    await expect(receiveByColor(s.id, ctx.point.id, [{ taskId: ctx.merah, qty: 5 }, { taskId: ctx.biru, qty: 0 }], actor, all)).rejects.toThrow(/belum melaporkan/);
    await saveWorkReport(s.id, ctx.point.id, [{ workerId: ctx.wA, taskId: ctx.biru, good: 5, reject: 0 }], true, ctx.mita, ctx.mitaScope);
    await expect(receiveByColor(s.id, ctx.point.id, [{ taskId: ctx.merah, qty: 5 }, { taskId: ctx.biru, qty: 5 }], actor, all)).rejects.toThrow(/belum melaporkan setoran/);
    const div: Scope = { all: false, pointIds: [ctx.point.id], personId: null, taskIds: [ctx.merah, ctx.biru], division: { id: "lain", captain: false } };
    await expect(receiveByColor(s.id, ctx.point.id, [{ taskId: ctx.merah, qty: 0 }, { taskId: ctx.biru, qty: 5 }], actor, div)).rejects.toThrow(/divisi penerima/);
    const ok: Scope = { ...div, division: { id: ctx.div, captain: false } };
    expect((await receiveByColor(s.id, ctx.point.id, [{ taskId: ctx.merah, qty: 0 }, { taskId: ctx.biru, qty: 5 }], actor, ok)).mismatch).toBe(false);
  });
});
