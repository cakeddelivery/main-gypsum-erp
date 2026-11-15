import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { allowedByPoint, kirimGroups, pointKits, taskGroupName } from "@/lib/boronganKirim";
import { createHandovers } from "@/lib/borongan";
import { saveItemRecord } from "@/lib/items";
import { resultPlaces } from "@/lib/resultCountGroups";

const item = (id: string, type = "BARANG_DALAM_PROSES", active = true) => ({ id, name: `Barang ${id}`, unit: "pcs", type, active });

describe("Kirim bahan: jenis pekerjaan aktif → titik → bahan", () => {
  it("nama kelompok membuang series/warna", () => {
    expect(taskGroupName("Single pack cowok")).toBe("Single Pack");
    expect(taskGroupName("Cat plastik biru")).toBe("Cat Plastik");
    expect(taskGroupName("Cat giftbox")).toBe("Cat Giftbox");
    expect(taskGroupName("Assembling")).toBe("Assembling");
  });

  it("titik dari pengaturan titik, bahan dari resep tugas aktif (setengah jadi dulu), tugas/barang nonaktif diabaikan", () => {
    const tasks = [
      { id: "sp1", name: "Single pack cowok", active: true, inputs: [{ item: item("kering-cwo") }, { item: item("plastik", "BAHAN_BAKU") }] },
      { id: "sp2", name: "Single pack cewek", active: true, inputs: [{ item: item("kering-cew") }] },
      { id: "cg", name: "Cat giftbox", active: true, inputs: [{ item: item("giftbox-polos") }, { item: item("cat", "BAHAN_BAKU") }] },
      { id: "cp", name: "Cat plastik biru", active: true, inputs: [{ item: item("plastik-polos") }, { item: item("lama", "BARANG_DALAM_PROSES", false) }] },
      { id: "old", name: "Tugas lama", active: false, inputs: [{ item: item("x") }] },
    ];
    const points = [
      { id: "bmr", name: "BMR", active: true, viaDriver: true },
      { id: "mst", name: "Mastrip", active: true, viaDriver: true },
      { id: "brn", name: "Beringin", active: true, viaDriver: false },
      { id: "off", name: "Tutup", active: false, viaDriver: true },
    ];
    const cfg = { bmr: { tasks: ["sp1", "sp2", "cg"] }, mst: { tasks: ["sp1", "sp2"] }, brn: { tasks: ["cp"] }, off: { tasks: [] } };
    const g = kirimGroups(tasks, points, cfg, new Map([["kering-cwo", 936], ["kering-cew", -242]]));
    expect(g.map((x) => [x.name, x.points.map((p) => p.name)])).toEqual([
      ["Cat Giftbox", ["BMR"]],
      ["Cat Plastik", ["Beringin"]],
      ["Single Pack", ["BMR", "Mastrip"]],
    ]);
    const sp = g.find((x) => x.name === "Single Pack")!;
    expect(sp.items.map((i) => [i.id, i.setengahJadi])).toEqual([["kering-cew", true], ["kering-cwo", true], ["plastik", false]]);
    expect(sp.items.find((i) => i.id === "kering-cew")!.stock).toBe(-242);
    expect(g.find((x) => x.name === "Cat Plastik")!.items.map((i) => i.id)).toEqual(["plastik-polos"]);
    expect(g.find((x) => x.name === "Cat Plastik")!.points[0].viaDriver).toBe(false);
    const allowed = allowedByPoint(g);
    expect(allowed.get("bmr")!.has("giftbox-polos")).toBe(true);
    expect(allowed.get("mst")!.has("giftbox-polos")).toBe(false);
    expect(allowed.get("brn")!.has("kering-cwo")).toBe(false);
    expect(allowed.has("off")).toBe(false);
    // Paket bahan titik (background/klip/cat) ikut boleh dikirim ke titiknya; tugas tanpa resep tetap tampil bila titik punya paket
    const kits = pointKits(points, { brn: { kit: ["cat-biru", "nonaktif"] } }, [{ id: "cat-biru", name: "Cat biru", unit: "botol", type: "BAHAN_BAKU", active: true }, { id: "nonaktif", name: "X", unit: "pcs", type: "BAHAN_BAKU", active: false }], new Map());
    expect(kits.brn.map((i) => i.id)).toEqual(["cat-biru"]);
    expect(allowedByPoint(g, kits).get("brn")!.has("cat-biru")).toBe(true);
    const tanpaResep = kirimGroups([{ id: "cp2", name: "Cat plastik merah", active: true, inputs: [] }], points, { brn: { tasks: ["cp2"], kit: ["cat-biru"] } }, new Map());
    expect(tanpaResep.map((x) => x.name)).toEqual(["Cat Plastik"]);
  });

  it("satu kali simpan ke dua titik: dua serah terima, semua atau tidak sama sekali", async () => {
    const actor = { id: (await prisma.user.findUniqueOrThrow({ where: { username: "owner" } })).id, name: "Owner" };
    const bmr = await prisma.boronganPoint.findUniqueOrThrow({ where: { code: "BMR" } });
    const mst = await prisma.boronganPoint.findUniqueOrThrow({ where: { code: "MST" } });
    const it = await saveItemRecord({ name: "Tes Kirim Multi Titik", type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0, price: 1000, openingQty: 50 }, actor);
    const hs = await createHandovers([
      { kind: "KIRIM", pointId: bmr.id, lines: [{ itemId: it.id, qty: 10 }] },
      { kind: "KIRIM", pointId: mst.id, lines: [{ itemId: it.id, qty: 5 }] },
      { kind: "KIRIM", pointId: mst.id, lines: [{ itemId: it.id, qty: 0 }] }, // kosong = tidak dikirim
    ], actor);
    expect(hs.map((h) => h.pointId)).toEqual([bmr.id, mst.id]);
    const before = await prisma.boronganHandover.count();
    await expect(createHandovers([
      { kind: "KIRIM", pointId: bmr.id, lines: [{ itemId: it.id, qty: 1 }] },
      { kind: "KIRIM", pointId: "bukan-titik", lines: [{ itemId: it.id, qty: 1 }] },
    ], actor)).rejects.toThrow();
    expect(await prisma.boronganHandover.count()).toBe(before);
    await expect(createHandovers([{ kind: "KIRIM", pointId: bmr.id, lines: [] }], actor)).rejects.toThrow(/minimal satu/);
  });
});

describe("Stok jadi berkelompok", () => {
  it("barang tanpa produk induk masuk kelompok setengah jadi / produk jadi lainnya", async () => {
    const m = await resultPlaces([{ id: "tanpa-induk-1", type: "BARANG_DALAM_PROSES" }, { id: "tanpa-induk-2", type: "BARANG_JADI" }]);
    expect(m.get("tanpa-induk-1")).toMatchObject({ group: "Barang setengah jadi", sub: "", col: "" });
    expect(m.get("tanpa-induk-2")!.group).toBe("Produk jadi lainnya");
  });
});
