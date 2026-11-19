import { describe, expect, it } from "vitest";
import type { Scope } from "@/lib/borongan";
import { canCancelShipment, canCompleteAssembling, canDistribute, canInputKering, canPickup, canReceive, canReport, canShip } from "@/lib/boronganFlow";
import { canSetOwnSchedule } from "@/lib/scheduleAccess";

const owner: Scope = { all: true, owner: true, backup: true, pointIds: [], personId: null, taskIds: null };
const supervisor: Scope = { all: true, owner: false, backup: true, pointIds: [], personId: null, taskIds: null };
const driver: Scope = { all: false, pointIds: ["bmr", "mst"], personId: "d", taskIds: null, driver: true };
const koor: Scope = { all: false, pointIds: ["bmr"], personId: "k", taskIds: null };
const viaDriver = { mode: "DRIVER" as const, taskIds: ["t"] };
const asm = [{ name: "Assembling Cowok", divisionId: "asm" }];

describe("Hak akses Kiriman per peran", () => {
  it("Supervisor: BACKUP semua aksi kiriman (bagi, ambil, lapor, terima, batal); tahanan tetap Owner", () => {
    expect([canShip(supervisor), canInputKering(supervisor), canCompleteAssembling(supervisor)]).toEqual([true, true, true]);
    expect(canDistribute(supervisor, viaDriver)).toBe(true);
    expect(canDistribute(supervisor, { mode: "LANGSUNG", taskIds: ["t"] })).toBe(true);
    expect(canPickup(supervisor, viaDriver)).toBe(true);
    expect(canReport(supervisor, { taskIds: ["t"] }, "bmr", true)).toBe(true);
    expect(canReceive(supervisor, asm)).toBe(true);
    expect(canCancelShipment(supervisor, { waitingSupport: false, createdById: "lain", _count: { allots: 3 } }, "spv")).toBe(true);
    expect(supervisor.owner).toBe(false); // koreksi/lepas tahanan hanya Owner
  });
  it("Owner: semua aksi", () => {
    expect([canDistribute(owner, viaDriver), canPickup(owner, viaDriver), canReport(owner, { taskIds: ["t"] }, "bmr", true), canReceive(owner, asm)]).toEqual([true, true, true, true]);
    expect(canCancelShipment(owner, { waitingSupport: false, createdById: "x", _count: { allots: 5 } }, "o")).toBe(true);
  });
  it("Driver: pembagian & ambil setoran lewat driver; Koordinator: lapor hasil titiknya", () => {
    expect([canDistribute(driver, viaDriver), canPickup(driver, viaDriver), canReport(driver, { taskIds: ["t"] }, "bmr", true)]).toEqual([true, true, false]);
    expect([canDistribute(koor, viaDriver), canReport(koor, { taskIds: ["t"] }, "bmr", true), canReport(koor, { taskIds: ["t"] }, "mst", true)]).toEqual([false, true, false]);
  });
  it("Batalkan: non-pengelola hanya pencatat selama belum dibagi ke pekerja", () => {
    const kapten: Scope = { all: false, pointIds: [], personId: null, taskIds: [], division: { id: "asm", captain: true, template: "ASSEMBLING" } };
    expect(canCancelShipment(kapten, { waitingSupport: false, createdById: "k", _count: { allots: 0 } }, "k")).toBe(true);
    expect(canCancelShipment(kapten, { waitingSupport: false, createdById: "k", _count: { allots: 3 } }, "k")).toBe(false);
  });
  it("Jadwal: Owner & Supervisor boleh mengatur jadwalnya sendiri", () => {
    expect(["OWNER", "SUPERVISOR", "ADMIN", "KAPTEN_DIVISI"].map(canSetOwnSchedule)).toEqual([true, true, false, false]);
  });
});

import { prisma } from "@/lib/db";
import { boronganScope } from "@/lib/borongan";
describe("Scope pengelola = backup", () => {
  it("Supervisor & Owner: backup true; owner hanya Owner; non-pengelola tidak backup", async () => {
    const can = (p: string) => p === "borongan.manage";
    const spv = await boronganScope(prisma, { id: "x", can: can as never, role: "SUPERVISOR" });
    const own = await boronganScope(prisma, { id: "x", can: can as never, role: "OWNER" });
    expect([spv.all, spv.backup, spv.owner]).toEqual([true, true, false]);
    expect([own.all, own.backup, own.owner]).toEqual([true, true, true]);
    const none = await boronganScope(prisma, { id: "nobody", can: (() => false) as never, role: "OPERATOR" });
    expect(none.backup).toBeFalsy();
  });
});
