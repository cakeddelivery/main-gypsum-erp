// Setoran borongan per divisi (urut nama: sesudah zAlurLapanganStok yang menyiapkan tugas per titik)
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { loadUser } from "@/lib/auth";
import { boronganScope, canTask, deleteResult, isSetoranOnly, recordResults, receiveHandover, savePerson, type Scope } from "@/lib/borongan";
import { recordMovement } from "@/lib/stock";
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

  it("catat & batalkan: pencatat sendiri atau kapten; bukan tugas divisi lain; tidak boleh atur pekerja/serah terima", async () => {
    const opA = await mkUser("op-gft-a", "OPERATOR", gft.id);
    const opB = await mkUser("op-gft-b", "OPERATOR", gft.id);
    const kap = await mkUser("kap-gft-uji", "KAPTEN_DIVISI", gft.id);
    const scope = (u: { id: string; role: string }) => boronganScope(prisma, { id: u.id, can: never, role: u.role, divisionId: gft.id });
    const sA: Scope = await scope(opA);
    const input = (taskId: string) => ({ pointId: bmr.id, workerId: worker.id, taskId, date: dateOnly("2027-09-10"), qty: 5 });

    await expect(recordResults([input(asmTask.id)], opA, sA)).rejects.toThrow(/divisi lain/);
    const [r1] = await recordResults([input(catGiftbox.id)], opA, sA);
    expect(r1.createdById).toBe(opA.id);
    // Rekap laporan shift Giftbox menampilkan setoran ini (tugas berdivisi Giftbox), Assembling tidak
    expect((await boronganLines("GIFTBOX", dateOnly("2027-09-10"), gft.id)).join("\n")).toContain("TOTAL SETORAN: 5");
    expect(await boronganLines("ASSEMBLING", dateOnly("2027-09-10"), asm.id)).toEqual([]);

    await expect(deleteResult(r1.id, opB, await scope(opB))).rejects.toThrow(/catat sendiri/);
    await deleteResult(r1.id, kap, await scope(kap));
    expect(await prisma.boronganResult.findUnique({ where: { id: r1.id } })).toBeNull();
    const log = await prisma.auditLog.findFirst({ where: { entityId: r1.id, action: "HASIL_BORONGAN_DIHAPUS" } });
    expect(log).toBeTruthy();

    const [r2] = await recordResults([input(catGiftbox.id)], opA, sA);
    await deleteResult(r2.id, opA, sA);

    await expect(savePerson({ name: "Pekerja Liar", role: "PEKERJA", pointId: bmr.id }, opA, sA)).rejects.toThrow(/pengelola borongan/);
    const h = await prisma.boronganHandover.create({ data: { number: "SRT-UJI-SETORAN", kind: "KIRIM", pointId: bmr.id, date: new Date(), createdBy: "uji" } });
    await expect(receiveHandover(h.id, opA, sA)).rejects.toThrow(/koordinator titik/);
  });
});
