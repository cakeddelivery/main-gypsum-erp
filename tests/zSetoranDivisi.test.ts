// Setoran borongan per divisi (urut nama: sesudah zAlurLapanganStok yang menyiapkan tugas per titik)
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { loadUser } from "@/lib/auth";
import { boronganScope, canTask, createHandover, deleteResult, isSetoranOnly, recordResults, receiveHandover, savePerson, warehouseFor, type Scope } from "@/lib/borongan";
import { allocate, cancelDivisionReceipt, diffLines, receiptDiff, receiptItems, receiptReportLines, recordDivisionReceipt } from "@/lib/boronganReceipt";
import { qtyAt, recordMovement } from "@/lib/stock";
import { boronganLines } from "@/lib/shiftReportBorongan";
import { dateOnly } from "@/lib/time";

const never = () => false;
let gft: { id: string };
let asm: { id: string };
let bmr: { id: string; locationId: string };
let catGiftbox: { id: string };
let asmTask: { id: string };
let worker: { id: string };
const mkUser = (username: string, role: "OPERATOR" | "KAPTEN_DIVISI", divisionId: string) =>
  prisma.user.create({ data: { username, name: username, passwordHash: "x", role, divisionId } });

beforeAll(async () => {
  gft = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "GIFTBOX" } });
  asm = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "ASSEMBLING" } });
  bmr = await prisma.boronganPoint.findFirstOrThrow({ where: { code: "BMR" } });
  catGiftbox = await prisma.pieceTask.findFirstOrThrow({ where: { name: { contains: "giftbox", mode: "insensitive" }, active: true }, include: { inputs: true } });
  asmTask = await prisma.pieceTask.findFirstOrThrow({ where: { name: { startsWith: "Assembling" }, active: true } });
  worker = await prisma.boronganPerson.create({ data: { name: "Pekerja BMR Setoran Uji", role: "PEKERJA", pointId: bmr.id } });
  if (!(await prisma.boronganPerson.findFirst({ where: { pointId: bmr.id, role: "KOORDINATOR", active: true } })))
    await prisma.boronganPerson.create({ data: { name: "Koordinator BMR Uji", role: "KOORDINATOR", pointId: bmr.id } });
  // Bahan per pcs Cat Giftbox tersedia di titik BMR
  const task = await prisma.pieceTask.findUniqueOrThrow({ where: { id: catGiftbox.id }, include: { inputs: true } });
  const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  for (const i of task.inputs) await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: i.itemId, qty: 10_000, toLocationId: bmr.locationId, unitCost: 10 }, { id: owner.id, name: owner.name }));
});

describe("Setoran borongan oleh anggota divisi", () => {
  it("tugas punya divisi pencatat bawaan; anggota Giftbox hanya tugas Cat Giftbox di titik BMR", async () => {
    expect((await prisma.pieceTask.findUniqueOrThrow({ where: { id: catGiftbox.id } })).divisionId).toBe(gft.id);
    expect((await prisma.pieceTask.findUniqueOrThrow({ where: { id: asmTask.id } })).divisionId).toBe(asm.id);
    const s = await boronganScope(prisma, { id: "u1", can: never, role: "OPERATOR", divisionId: gft.id });
    expect(isSetoranOnly(s)).toBe(true);
    expect(s.pointIds).toEqual([bmr.id]);
    expect(canTask(s, catGiftbox.id)).toBe(true);
    expect(canTask(s, asmTask.id)).toBe(false);
    // Divisi tanpa tugas borongan tidak mendapat akses
    const pck = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" } });
    expect((await boronganScope(prisma, { id: "u2", can: never, role: "OPERATOR", divisionId: pck.id })).pointIds).toEqual([]);
  });

  it("izin menu: Operator Giftbox & Assembling dapat akses setoran, Operator Packing tidak", async () => {
    const a = await mkUser("op-gft-uji", "OPERATOR", gft.id);
    const pck = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" } });
    const b = await mkUser("op-pck-uji", "OPERATOR", pck.id);
    expect((await loadUser(a.id, 0))!.can("borongan.point")).toBe(true);
    expect((await loadUser(a.id, 0))!.can("borongan.manage")).toBe(false);
    expect((await loadUser(b.id, 0))!.can("borongan.point")).toBe(false);
  });

  it("setoran per pekerja khusus koordinator/pengelola; divisi mencatat penerimaan per barang (stok titik → gudang, tidak dobel, selisih tampil)", async () => {
    const opA = await mkUser("op-gft-a", "OPERATOR", gft.id);
    const opB = await mkUser("op-gft-b", "OPERATOR", gft.id);
    const kap = await mkUser("kap-gft-uji", "KAPTEN_DIVISI", gft.id);
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const sOwner = await boronganScope(prisma, { id: owner.id, can: () => true });
    const scope = (u: { id: string; role: string }) => boronganScope(prisma, { id: u.id, can: never, role: u.role, divisionId: gft.id });
    const sA: Scope = await scope(opA);
    const day = dateOnly("2027-09-10");
    const input = (taskId: string) => ({ pointId: bmr.id, workerId: worker.id, taskId, date: day, qty: 5 });

    // Anggota divisi tidak lagi mencatat setoran per pekerja (dasar upah)
    await expect(recordResults([input(catGiftbox.id)], opA, sA)).rejects.toThrow(/koordinator titik/);
    const [r1] = await recordResults([input(catGiftbox.id)], owner, sOwner);
    expect((await boronganLines("GIFTBOX", day, gft.id)).join("\n")).toContain("TOTAL SETORAN: 5");

    const items = await receiptItems(gft.id);
    const pot = items.find((i) => i.taskIds.includes(catGiftbox.id))!;
    expect(pot).toBeTruthy();
    const it = await prisma.item.findUniqueOrThrow({ where: { id: pot.id } });
    const wh = await warehouseFor(prisma, it.type);
    const at0 = await qtyAt(prisma, it.id, bmr.locationId);
    const wh0 = await qtyAt(prisma, it.id, wh);

    // Penerimaan divisi: 3 bagus + 1 reject, titik tidak diisi (otomatis BMR)
    await expect(recordDivisionReceipt({ divisionId: asm.id, date: day, lines: [{ itemId: it.id, qty: 1 }] }, opA, sA)).rejects.toThrow(/anggota divisi penerima/);
    const rec = await recordDivisionReceipt({ divisionId: gft.id, date: day, lines: [{ itemId: it.id, qty: 3, reject: 1 }] }, opA, sA);
    expect(rec.lines).toEqual([expect.objectContaining({ pointId: bmr.id })]);
    expect(await qtyAt(prisma, it.id, bmr.locationId)).toBe(at0 - 4);
    expect(await qtyAt(prisma, it.id, wh)).toBe(wh0 + 3);
    const diff = (await receiptDiff(gft.id, day, day)).find((r) => r.itemId === it.id)!;
    expect(diff).toMatchObject({ setoran: 5, diterima: 3, rejectDiterima: 1, selisih: -1 });
    expect(diffLines([diff])[0]).toMatch(/selisih -1 \(BMR -1\)/);
    expect((await receiptReportLines(gft.id, day)).join("\n")).toContain("selisih -1");

    // Tidak dobel: hasil tugas berdivisi tidak boleh lewat "Kirim hasil ke gudang"
    await expect(createHandover({ kind: "KEMBALI", pointId: bmr.id, lines: [{ itemId: it.id, qty: 1 }] }, owner)).rejects.toThrow(/Penerimaan hasil borongan/);

    // Batal: anggota lain ditolak, kapten boleh; stok kembali ke titik
    await expect(cancelDivisionReceipt(rec.id, opB, await scope(opB))).rejects.toThrow(/catat sendiri/);
    await cancelDivisionReceipt(rec.id, kap, await scope(kap));
    expect(await qtyAt(prisma, it.id, bmr.locationId)).toBe(at0);
    expect(await qtyAt(prisma, it.id, wh)).toBe(wh0);
    expect((await receiptDiff(gft.id, day, day)).find((r) => r.itemId === it.id)).toMatchObject({ diterima: 0, selisih: -5 });

    // Diterima lebih dari setoran: titik minus, selisih plus
    await recordDivisionReceipt({ divisionId: gft.id, date: day, lines: [{ itemId: it.id, qty: at0 + 2 }] }, opA, sA);
    expect(await qtyAt(prisma, it.id, bmr.locationId)).toBe(-2);
    expect(allocate(10, [{ pointId: "a", qty: 3 }, { pointId: "b", qty: 5 }], "a")).toEqual(new Map([["b", 5], ["a", 5]]));

    // Batal setoran per pekerja tetap mengikuti aturan #93 (pengelola boleh)
    await deleteResult(r1.id, owner, sOwner);
    const log = await prisma.auditLog.findFirst({ where: { entityId: r1.id, action: "HASIL_BORONGAN_DIHAPUS" } });
    expect(log).toBeTruthy();

    await expect(savePerson({ name: "Pekerja Liar", role: "PEKERJA", pointId: bmr.id }, opA, sA)).rejects.toThrow(/pengelola borongan/);
    const h = await prisma.boronganHandover.create({ data: { number: "SRT-UJI-SETORAN", kind: "KIRIM", pointId: bmr.id, date: new Date(), createdBy: "uji" } });
    await expect(receiveHandover(h.id, opA, sA)).rejects.toThrow(/koordinator titik/);
  });
});

describe("Mutasi stok manual dibatasi (tidak dobel dengan Serah terima / Pembelian)", () => {
  it("titik & driver ditolak, penerimaan hanya Owner + alasan, penyesuaian wajib alasan; Cek Konsistensi menandai mutasi manual lama", async () => {
    const { manualMovementGuard, locationSettings } = await import("@/lib/stock");
    const { CHECKS } = await import("@/lib/consistency");
    const raw = (await locationSettings(prisma)).raw!;
    await expect(manualMovementGuard({ type: "TRANSFER", role: "OWNER", reason: "x", fromLocationId: raw, toLocationId: bmr.locationId })).rejects.toThrow(/Serah terima/);
    await expect(manualMovementGuard({ type: "PENERIMAAN", role: "ADMIN", reason: "x", fromLocationId: null, toLocationId: raw })).rejects.toThrow(/Pembelian/);
    await expect(manualMovementGuard({ type: "PENERIMAAN", role: "OWNER", reason: "", fromLocationId: null, toLocationId: raw })).rejects.toThrow(/alasan/);
    await expect(manualMovementGuard({ type: "PENERIMAAN", role: "OWNER", reason: "hibah", fromLocationId: null, toLocationId: raw })).resolves.toBeUndefined();
    await expect(manualMovementGuard({ type: "PENYESUAIAN", role: "OWNER", reason: null, fromLocationId: raw, toLocationId: null })).rejects.toThrow(/alasan/);
    await expect(manualMovementGuard({ type: "PENGELUARAN", role: "ADMIN", reason: null, fromLocationId: raw, toLocationId: null })).resolves.toBeUndefined();
    // Mutasi manual lama ke titik (sebelum dibatasi) ditandai
    const item = await prisma.item.findFirstOrThrow({ where: { type: "BAHAN_BAKU" } });
    await prisma.stockMovement.create({ data: { type: "TRANSFER", itemId: item.id, qty: 1, fromLocationId: raw, toLocationId: bmr.locationId, unitCost: BigInt(0), ref: "MUT", createdBy: "uji", date: new Date() } });
    const check = CHECKS.find((c) => c.name === "manualBorongan")!;
    const r = await check({ now: new Date(), today: "2026-11-14" });
    expect(r?.key).toBe("mutasi-manual-borongan");
  });
});
