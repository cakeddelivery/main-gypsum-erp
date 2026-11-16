import { describe, expect, it } from "vitest";
import type { Scope } from "@/lib/borongan";
import { canCancelShipment, canCompleteAssembling, canDistribute, canInputKering, canPickup, canReceive, canReport, canShip } from "@/lib/boronganFlow";
import { canSetOwnSchedule } from "@/lib/scheduleAccess";

const owner: Scope = { all: true, owner: true, pointIds: [], personId: null, taskIds: null };
const supervisor: Scope = { all: true, owner: false, pointIds: [], personId: null, taskIds: null };
const driver: Scope = { all: false, pointIds: ["bmr", "mst"], personId: "d", taskIds: null, driver: true };
const koor: Scope = { all: false, pointIds: ["bmr"], personId: "k", taskIds: null };
const viaDriver = { mode: "DRIVER" as const, taskIds: ["t"] };
const asm = [{ name: "Assembling Cowok", divisionId: "asm" }];

describe("Hak akses Kiriman per peran", () => {
  it("Supervisor: hanya input kiriman & memantau", () => {
    expect([canShip(supervisor), canInputKering(supervisor), canCompleteAssembling(supervisor)]).toEqual([true, true, true]);
    expect(canDistribute(supervisor, viaDriver)).toBe(false); // Ubah pembagian
    expect(canPickup(supervisor, viaDriver)).toBe(false); // Ambil setoran
    expect(canReport(supervisor, { taskIds: ["t"] }, "bmr", true)).toBe(false); // Lapor hasil
    expect(canReceive(supervisor, asm)).toBe(false);
    expect(canCancelShipment(supervisor, { waitingSupport: false, createdById: "lain", _count: { allots: 0 } }, "spv")).toBe(false);
  });
  it("Owner: semua aksi", () => {
    expect([canDistribute(owner, viaDriver), canPickup(owner, viaDriver), canReport(owner, { taskIds: ["t"] }, "bmr", true), canReceive(owner, asm)]).toEqual([true, true, true, true]);
    expect(canCancelShipment(owner, { waitingSupport: false, createdById: "x", _count: { allots: 5 } }, "o")).toBe(true);
  });
  it("Driver: pembagian & ambil setoran lewat driver; Koordinator: lapor hasil titiknya", () => {
    expect([canDistribute(driver, viaDriver), canPickup(driver, viaDriver), canReport(driver, { taskIds: ["t"] }, "bmr", true)]).toEqual([true, true, false]);
    expect([canDistribute(koor, viaDriver), canReport(koor, { taskIds: ["t"] }, "bmr", true), canReport(koor, { taskIds: ["t"] }, "mst", true)]).toEqual([false, true, false]);
  });
  it("Batalkan: pencatat selama belum dibagi ke pekerja", () => {
    expect(canCancelShipment(supervisor, { waitingSupport: false, createdById: "spv", _count: { allots: 0 } }, "spv")).toBe(true);
    expect(canCancelShipment(supervisor, { waitingSupport: false, createdById: "spv", _count: { allots: 3 } }, "spv")).toBe(false);
  });
  it("Jadwal: Owner & Supervisor boleh mengatur jadwalnya sendiri", () => {
    expect(["OWNER", "SUPERVISOR", "ADMIN", "KAPTEN_DIVISI"].map(canSetOwnSchedule)).toEqual([true, true, false, false]);
  });
});
