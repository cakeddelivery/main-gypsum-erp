import { describe, expect, it } from "vitest";
import { forCoordinator, scopeShipments, type ShipmentView } from "@/lib/boronganFlow";
import type { Scope } from "@/lib/borongan";

const cell = (pointId: string, workerId: string, taskId: string, dibagi: number, diambil = 0) => ({ pointId, workerId, worker: workerId, taskId, dibagi, diambil, good: 0, reject: 0, reported: false, done: false });
const view = (cells: ShipmentView["cells"]): ShipmentView => ({
  id: "s1", number: "KRM-161126-01", date: "2026-11-16", mode: "DRIVER", driver: "Edy", state: "DI_PEKERJA", note: null, createdBy: "x", cancelled: false, waitingSupport: false,
  group: "Assembling",
  points: [{ id: "bmr", name: "BMR", coordinator: true }, { id: "mst", name: "Mastrip", coordinator: true }],
  tasks: [{ id: "t1", name: "Assembling Cewek", short: "Cewek", qty: 2000, divisionId: null }, { id: "t2", name: "Assembling Cowok", short: "Cowok", qty: 1700, divisionId: null }],
  lines: [{ itemId: "i", name: "Patung kering Cewek", unit: "pcs", qty: 2000, support: false }],
  cells,
  pickups: [{ id: "p1", number: "AMB-1", date: "2026-11-16", status: "DITERIMA", driver: "Edy", holdNote: null, lines: [{ id: "l1", pointId: "bmr", workerId: "w1", worker: "w1", taskId: "t1", qty: 100, reject: 0, done: false }, { id: "l2", pointId: "mst", workerId: "w3", worker: "w3", taskId: "t2", qty: 50, reject: 0, done: false }], counts: [{ taskId: "t1", qty: 150 }] }],
  reports: [{ pointId: "mst", at: "", by: "y", checked: true }],
  totals: { sent: 3700, allotted: 0, received: 150, reject: 0, atWorkers: 3700, gap: null },
});
const coord: Scope = { all: false, pointIds: ["bmr"], personId: "k1", taskIds: null };

describe("Portal koordinator: hanya titik sendiri", () => {
  it("kiriman belum dibagi di titiknya tidak tampil", () => {
    expect(forCoordinator(view([]), ["bmr"])).toBeNull();
    expect(forCoordinator(view([cell("mst", "w3", "t2", 1700)]), ["bmr"])).toBeNull();
  });
  it("angka & nama titik hanya bagian titik koordinator", () => {
    const v = forCoordinator(view([cell("bmr", "w1", "t1", 1200, 100), cell("bmr", "w2", "t1", 800), cell("mst", "w3", "t2", 1700, 50)]), ["bmr"])!;
    expect(v.points.map((p) => p.name)).toEqual(["BMR"]);
    expect(v.totals.sent).toBe(2000);
    expect(v.tasks).toEqual([expect.objectContaining({ id: "t1", qty: 2000 })]);
    expect(v.cells.every((c) => c.pointId === "bmr")).toBe(true);
    expect(v.pickups[0].lines.map((l) => l.pointId)).toEqual(["bmr"]);
    expect(v.pickups[0].counts).toEqual([]); // hitungan divisi mencakup titik lain
    expect(v.totals.received).toBe(100);
    expect(v.lines).toEqual([]);
    expect(v.reports).toEqual([]);
    expect(JSON.stringify(v)).not.toContain("Mastrip");
  });
  it("pengelola melihat semuanya", () => {
    const list = [view([cell("mst", "w3", "t2", 1700)])];
    expect(scopeShipments({ all: true, pointIds: [], personId: null, taskIds: null }, list)).toHaveLength(1);
    expect(scopeShipments(coord, list)).toHaveLength(0);
  });
});
