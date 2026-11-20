import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { coordinatorFor, ratesFor, type Scope } from "@/lib/borongan";
import { canReport, coordinatorOnly } from "@/lib/boronganFlow";
import { canRequestClaim, claimBreakdown } from "@/lib/boronganClaim";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const ids = { brn: "", biasa: "", mita: "", koord: "", wBrn: "", wBiasa: "", task: "" };

describe("Titik tanpa fee koordinator dengan koordinator pencatat (Beringin · Mita)", () => {
  beforeAll(async () => {
    const mk = async (code: string, noCoordinator: boolean) => {
      const loc = await prisma.location.create({ data: { code: `LP${code}`, name: `Titik ${code}` } });
      return prisma.boronganPoint.create({ data: { code, name: `Titik ${code}`, locationId: loc.id, noCoordinator } });
    };
    const brn = await mk(`BR${tag}`, true);
    const biasa = await mk(`BS${tag}`, false);
    const mita = await prisma.boronganPerson.create({ data: { name: `Mita ${tag}`, role: "KOORDINATOR", pointId: brn.id } });
    const koord = await prisma.boronganPerson.create({ data: { name: `Koord ${tag}`, role: "KOORDINATOR", pointId: biasa.id } });
    // Pekerja Beringin bahkan memilih Mita sebagai koordinatornya: tetap tanpa fee koordinator
    const wBrn = await prisma.boronganPerson.create({ data: { name: `Pekerja BR ${tag}`, role: "PEKERJA", pointId: brn.id, coordinatorId: mita.id } });
    const wBiasa = await prisma.boronganPerson.create({ data: { name: `Pekerja BS ${tag}`, role: "PEKERJA", pointId: biasa.id } });
    const div = await prisma.division.create({ data: { code: `PC${tag}`, name: `Pencatat ${tag}` } });
    const task = await prisma.pieceTask.create({ data: { code: `PC${tag}`, name: `Cat pencatat ${tag}`, divisionId: div.id, ratePerPcs: 15n, workerRate: 13n, coordinatorRate: 2n, driverRate: 0n } });
    Object.assign(ids, { brn: brn.id, biasa: biasa.id, mita: mita.id, koord: koord.id, wBrn: wBrn.id, wBiasa: wBiasa.id, task: task.id });
  });
  afterAll(async () => {
    await prisma.boronganPerson.updateMany({ where: { pointId: { in: [ids.brn, ids.biasa] } }, data: { active: false } });
    await prisma.boronganPoint.updateMany({ where: { id: { in: [ids.brn, ids.biasa] } }, data: { active: false } });
  });

  it("upah: Beringin tanpa fee koordinator walau ada Mita (bagian koordinator ke pekerja); titik biasa tetap ke koordinator", async () => {
    const wBrn = await prisma.boronganPerson.findUniqueOrThrow({ where: { id: ids.wBrn } });
    const wBiasa = await prisma.boronganPerson.findUniqueOrThrow({ where: { id: ids.wBiasa } });
    expect(await coordinatorFor(prisma, wBrn)).toBeNull();
    expect((await coordinatorFor(prisma, wBiasa))?.id).toBe(ids.koord);
    const task = await prisma.pieceTask.findUniqueOrThrow({ where: { id: ids.task } });
    expect(ratesFor(task, null)).toEqual({ workerRate: 15n, coordinatorRate: 0n, driverRate: 0n });
    // Klaim upah Beringin: tanpa baris fee koordinator
    const b = claimBreakdown([{ qty: 10, ...ratesFor(task, null), task: { name: task.name }, worker: { id: ids.wBrn, name: "W" }, coordinator: null, driver: null }]);
    expect(b.coordinators).toEqual([]);
    expect(b.totals.all).toBe(150);
  });

  it("akses: Mita & tim divisi (cadangan) boleh lapor hasil di Beringin; titik biasa hanya koordinatornya", async () => {
    expect(await coordinatorOnly(prisma, ids.brn)).toBe(false);
    expect(await coordinatorOnly(prisma, ids.biasa)).toBe(true);
    const mitaScope: Scope = { all: false, pointIds: [ids.brn], personId: ids.mita, taskIds: null };
    const divisi: Scope = { all: false, pointIds: [ids.brn, ids.biasa], personId: null, taskIds: [ids.task], division: { id: "d", captain: false, template: "ASSEMBLING" } };
    const s = { taskIds: [ids.task] };
    expect(canReport(mitaScope, s, ids.brn, false)).toBe(true);
    expect(canReport(mitaScope, s, ids.biasa, true)).toBe(false); // hanya titiknya sendiri
    expect(canReport(divisi, s, ids.brn, false)).toBe(true);
    expect(canReport(divisi, s, ids.biasa, true)).toBe(false);
    // Klaim Upah Sekarang: sama dengan koordinator lain (Mita), disetujui Finance/Owner
    expect(canRequestClaim(mitaScope, ids.brn, true)).toBe(true);
    expect(canRequestClaim(divisi, ids.brn, true)).toBe(false);
  });
});

describe("Pilihan koordinator per pekerja ke titik lain yang ber-fee tetap diutamakan", () => {
  it("pekerja di titik tanpa fee memilih koordinator titik biasa → fee ke koordinator itu", async () => {
    const t = Date.now().toString(36).slice(-5).toUpperCase();
    const mk = async (code: string, noCoordinator: boolean) => {
      const loc = await prisma.location.create({ data: { code: `LQ${code}`, name: `Titik ${code}` } });
      return prisma.boronganPoint.create({ data: { code, name: `Titik ${code}`, locationId: loc.id, noCoordinator, active: false } });
    };
    const a = await mk(`QA${t}`, true);
    const b = await mk(`QB${t}`, false);
    const k = await prisma.boronganPerson.create({ data: { name: `K ${t}`, role: "KOORDINATOR", pointId: b.id } });
    expect((await coordinatorFor(prisma, { pointId: a.id, coordinatorId: k.id }))?.id).toBe(k.id);
    await prisma.boronganPerson.update({ where: { id: k.id }, data: { active: false } });
  });
});
