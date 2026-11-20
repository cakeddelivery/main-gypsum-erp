import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { boronganScope, coordinatorFor, coordinatorsAt, ratesFor, savePerson, type Scope } from "@/lib/borongan";
import { PAYDAY_KEY, duePoints, paydayAlerts, paydayConfig, paydayRecipients, paydayText, savePayday, unclaimedSummary } from "@/lib/boronganPayday";
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

describe("Koordinator multi-titik: Mita BMR (ber-fee) + Beringin (tanpa fee) & pengingat hari bayar", () => {
  const t = `M${Date.now().toString(36).slice(-4).toUpperCase()}`;
  const ctx = { bmr: "", brn: "", mita: "", user: "", wBmr: "", wBrn: "", task: "" };
  const all = { all: true, pointIds: [], personId: null, taskIds: null } as Scope;
  const actor = { id: "uji", name: "Uji" };
  beforeAll(async () => {
    const mk = async (code: string, noCoordinator: boolean) => {
      const loc = await prisma.location.create({ data: { code: `LM${code}`, name: `Titik ${code}` } });
      return prisma.boronganPoint.create({ data: { code, name: `Titik ${code}`, locationId: loc.id, noCoordinator } });
    };
    const bmr = await mk(`MB${t}`, false);
    const brn = await mk(`MR${t}`, true);
    const user = await prisma.user.create({ data: { username: `mita${t.toLowerCase()}`, name: `Mita ${t}`, passwordHash: "x", role: "KOORDINATOR" } });
    // Mita sudah koordinator BMR; pengelola menambahkan Beringin sebagai titik tambahan lewat form Orang
    const mita = await savePerson({ name: `Mita ${t}`, role: "KOORDINATOR", pointId: bmr.id }, actor, all);
    await prisma.boronganPerson.update({ where: { id: mita.id }, data: { userId: user.id } });
    await savePerson({ id: mita.id, name: mita.name, role: "KOORDINATOR", pointId: bmr.id, extraPointIds: [brn.id, bmr.id] }, actor, all);
    const wBmr = await prisma.boronganPerson.create({ data: { name: `W BMR ${t}`, role: "PEKERJA", pointId: bmr.id } });
    const wBrn = await prisma.boronganPerson.create({ data: { name: `W BRN ${t}`, role: "PEKERJA", pointId: brn.id, coordinatorId: mita.id } });
    const div = await prisma.division.create({ data: { code: `MD${t}`, name: `Div ${t}` } });
    const task = await prisma.pieceTask.create({ data: { code: `MT${t}`, name: `Cat multi ${t}`, divisionId: div.id, ratePerPcs: 15n, workerRate: 13n, coordinatorRate: 2n, driverRate: 0n } });
    Object.assign(ctx, { bmr: bmr.id, brn: brn.id, mita: mita.id, user: user.id, wBmr: wBmr.id, wBrn: wBrn.id, task: task.id });
  });
  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: { in: [PAYDAY_KEY, `job_borongan_bayar_${ctx.brn}`] } } });
    await prisma.boronganPerson.updateMany({ where: { OR: [{ pointId: { in: [ctx.bmr, ctx.brn] } }, { id: ctx.mita }] }, data: { active: false } });
    await prisma.boronganPoint.updateMany({ where: { id: { in: [ctx.bmr, ctx.brn] } }, data: { active: false } });
  });

  it("penugasan: titik tambahan tersimpan (titik utama tidak dobel); Mita melihat kedua titiknya saja", async () => {
    expect((await prisma.boronganCoordinatorPoint.findMany({ where: { personId: ctx.mita } })).map((x) => x.pointId)).toEqual([ctx.brn]);
    const scope = await boronganScope(prisma, { id: ctx.user, can: () => false, role: "KOORDINATOR" });
    expect(scope.pointIds.sort()).toEqual([ctx.bmr, ctx.brn].sort());
    expect(scope.personId).toBe(ctx.mita);
    expect(await prisma.boronganPerson.count({ where: coordinatorsAt(ctx.brn) })).toBe(1);
  });

  it("fee: BMR tetap ke Mita; Beringin tanpa fee walau pekerja memilih Mita; akses lapor & klaim per titik", async () => {
    const w = async (id: string) => prisma.boronganPerson.findUniqueOrThrow({ where: { id } });
    expect((await coordinatorFor(prisma, await w(ctx.wBmr)))?.id).toBe(ctx.mita);
    expect(await coordinatorFor(prisma, await w(ctx.wBrn))).toBeNull();
    expect(await coordinatorOnly(prisma, ctx.bmr)).toBe(true);
    expect(await coordinatorOnly(prisma, ctx.brn)).toBe(false);
    const scope = await boronganScope(prisma, { id: ctx.user, can: () => false, role: "KOORDINATOR" });
    expect(canReport(scope, { taskIds: [ctx.task] }, ctx.brn, false)).toBe(true);
    expect(canReport(scope, { taskIds: [ctx.task] }, ctx.bmr, true)).toBe(true);
    expect(canRequestClaim(scope, ctx.brn, true)).toBe(true);
    expect(canRequestClaim(scope, ctx.bmr, true)).toBe(true);
  });

  it("melepas titik tambahan lewat form: Beringin tidak lagi dipegang Mita", async () => {
    await savePerson({ id: ctx.mita, name: `Mita ${t}`, role: "KOORDINATOR", pointId: ctx.bmr, extraPointIds: [] }, actor, all);
    expect(await prisma.boronganCoordinatorPoint.count({ where: { personId: ctx.mita } })).toBe(0);
    await savePerson({ id: ctx.mita, name: `Mita ${t}`, role: "KOORDINATOR", pointId: ctx.bmr, extraPointIds: [ctx.brn] }, actor, all);
  });

  it("pengingat hari bayar: Senin → dikirim Minggu 08:00 WIB ke Mita + Finance + Owner, isi setoran belum diklaim", async () => {
    await savePayday(ctx.brn, 1, "08:00", actor);
    const cfg = await paydayConfig();
    expect(cfg[ctx.brn]).toEqual({ day: 1, time: "08:00" });
    // 2026-11-22 = Minggu. 07:59 WIB belum; 08:00 WIB jatuh tempo; Senin tidak
    expect(duePoints(cfg, new Date("2026-11-22T00:59:00Z"))).not.toContain(ctx.brn);
    expect(duePoints(cfg, new Date("2026-11-22T01:00:00Z"))).toContain(ctx.brn);
    expect(duePoints(cfg, new Date("2026-11-23T01:00:00Z"))).not.toContain(ctx.brn);
    await prisma.boronganResult.create({ data: { number: `SET-M${t}`, pointId: ctx.brn, workerId: ctx.wBrn, taskId: ctx.task, date: new Date("2026-11-21"), qty: 10, workerRate: 15n, coordinatorRate: 0n, driverRate: 0n, createdBy: "uji" } });
    const s = await unclaimedSummary(ctx.brn);
    expect(s).toEqual({ setoran: 1, pcs: 10, total: 150 });
    const txt = paydayText("Beringin", 1, s);
    expect(txt.title).toBe("Besok Senin pembayaran upah borongan Beringin — ajukan/cek klaim");
    expect(txt.body).toMatch(/1 setoran · 10 pcs · estimasi Rp150/);
    const to = await paydayRecipients(ctx.brn);
    expect(to).toContain(ctx.user);
    const owner = await prisma.user.findFirstOrThrow({ where: { role: "OWNER", active: true } });
    expect(to).toContain(owner.id);
    // Lonceng: Mita (titiknya) & Owner pada Minggu ≥ 08:00 dan hari Senin; pengguna lain tidak
    const sun = new Date("2026-11-22T02:00:00Z");
    expect((await paydayAlerts({ id: ctx.user, role: "KOORDINATOR" }, sun)).some((a) => a.key.startsWith(`borongan-bayar-${ctx.brn}`))).toBe(true);
    expect((await paydayAlerts({ id: owner.id, role: "OWNER" }, new Date("2026-11-23T02:00:00Z"))).some((a) => a.label.startsWith("Hari ini Senin"))).toBe(true);
    expect(await paydayAlerts({ id: "lain", role: "OPERATOR" }, sun)).toEqual([]);
    expect(await paydayAlerts({ id: ctx.user, role: "KOORDINATOR" }, new Date("2026-11-25T02:00:00Z"))).toEqual([]);
  });
});
