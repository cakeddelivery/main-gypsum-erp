import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { checkSplit, createHandover, deleteResult, payLines, receiveHandover, recordResult, removePerson, resultShares, savePerson, settlePoint, type Scope } from "@/lib/borongan";
import { saveItemRecord } from "@/lib/items";
import { stockBalances } from "@/lib/stock";
import { dateOnly } from "@/lib/time";
import { COA } from "@/lib/accounting";

let actor: { id: string; name: string };
const all: Scope = { all: true, pointIds: [], personId: null };
let bmr: { id: string; locationId: string };
let mst: { id: string; locationId: string };
let seabank: string;

const at = async (itemId: string, locationId: string) => (await stockBalances(prisma, itemId)).find((b) => b.locationId === locationId)?.qty ?? 0;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  bmr = await prisma.boronganPoint.findUniqueOrThrow({ where: { code: "BMR" } });
  mst = await prisma.boronganPoint.findUniqueOrThrow({ where: { code: "MST" } });
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
});

describe("Pembagian budget", () => {
  it("budget harus habis dibagi", () => {
    expect(() => checkSplit(60, { workerRate: 30, coordinatorRate: 15, driverRate: 15 })).not.toThrow();
    expect(() => checkSplit(100, { workerRate: 80, coordinatorRate: 10, driverRate: 0 })).toThrow(/harus sama/);
    expect(resultShares(10, { workerRate: 30, coordinatorRate: 15, driverRate: 15 })).toEqual({ worker: 300, coordinator: 150, driver: 150, total: 600 });
  });
  it("tarif awal sesuai pembagian", async () => {
    const t = await prisma.pieceTask.findUniqueOrThrow({ where: { code: "ASSEMBLING" } });
    expect([t.ratePerPcs, t.workerRate, t.coordinatorRate, t.driverRate].map(Number)).toEqual([60, 30, 15, 15]);
  });
});

describe("Alur borongan tetangga", () => {
  it("kirim bahan → terima → setor hasil → kirim balik → bayar upah", async () => {
    const coord = await savePerson({ name: "Bu Koordinator BMR", role: "KOORDINATOR", pointId: bmr.id }, actor, all);
    const driver = await savePerson({ name: "Cak Ed Driver", role: "DRIVER" }, actor, all);
    const coordScope: Scope = { all: false, pointIds: [bmr.id], personId: coord.id };
    // Koordinator menambah pekerja di titiknya sendiri, tidak bisa di titik lain
    const w1 = await savePerson({ name: "Tetangga Satu", role: "PEKERJA", pointId: bmr.id }, actor, coordScope);
    const w2 = await savePerson({ name: "Tetangga Dua", role: "PEKERJA", pointId: bmr.id }, actor, coordScope);
    await expect(savePerson({ name: "Orang Mastrip", role: "PEKERJA", pointId: mst.id }, actor, coordScope)).rejects.toThrow(/titik/);
    await expect(savePerson({ name: "Koordinator Palsu", role: "KOORDINATOR", pointId: bmr.id }, actor, coordScope)).rejects.toThrow(/pekerja/);

    // Bahan: cat (bahan baku, per gram) dan giftbox polos (setengah jadi) → giftbox dicat
    const cat = await saveItemRecord({ name: "Cat Uji Borongan", type: "BAHAN_BAKU", category: "Cat & Pewarna", unit: "botol", hppUnit: "gram", hppFactor: 1000, minStock: 0, price: 50_000, openingQty: 4 }, actor);
    const polos = await saveItemRecord({ name: "Giftbox Polos Uji", type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0, price: 1_000, openingQty: 100 }, actor);
    const jadi = await saveItemRecord({ name: "Giftbox Dicat Uji", type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi", unit: "pcs", hppFactor: 1, minStock: 0 }, actor);
    const task = await prisma.pieceTask.update({ where: { code: "ASSEMBLING" }, data: { outputItemId: jadi.id, inputs: { create: [{ itemId: polos.id, qty: 1 }, { itemId: cat.id, qty: 20 }] } } });

    const h = await createHandover({ kind: "KIRIM", pointId: bmr.id, driverId: driver.id, lines: [{ itemId: cat.id, qty: 2 }, { itemId: polos.id, qty: 60 }] }, actor);
    const raw = (await prisma.setting.findUniqueOrThrow({ where: { key: "loc_raw" } })).value;
    expect(await at(cat.id, raw)).toBe(2); // keluar gudang saat diserahkan ke driver
    expect(await at(cat.id, bmr.locationId)).toBe(0);
    await expect(receiveHandover(h.id, actor, { all: false, pointIds: [mst.id], personId: null })).rejects.toThrow(/titik/);
    await receiveHandover(h.id, actor, coordScope);
    expect(await at(polos.id, bmr.locationId)).toBe(60);

    const date = dateOnly("2027-04-10");
    const r1 = await recordResult({ pointId: bmr.id, workerId: w1.id, taskId: task.id, date, qty: 40 }, actor, coordScope);
    await recordResult({ pointId: bmr.id, workerId: w2.id, taskId: task.id, date, qty: 10 }, actor, coordScope);
    expect(await at(polos.id, bmr.locationId)).toBe(10);
    expect(await at(cat.id, bmr.locationId)).toBeCloseTo(1, 5); // 50 pcs × 20 gram = 1 botol
    expect(await at(jadi.id, bmr.locationId)).toBe(50);
    // Nilai cat pindah ke persediaan barang dalam proses
    const j = await prisma.journal.findFirstOrThrow({ where: { source: "BORONGAN", sourceId: r1.id }, include: { lines: { include: { account: true } } } });
    expect(j.lines.find((l) => l.account.code === COA.PERSEDIAAN_BAHAN)?.credit.toString()).toBe("40000");

    // Hapus & catat ulang tetap konsisten
    const r3 = await recordResult({ pointId: bmr.id, workerId: w2.id, taskId: task.id, date, qty: 5 }, actor, coordScope);
    await deleteResult(r3.id, actor, coordScope);
    expect(await at(jadi.id, bmr.locationId)).toBe(50);

    // Hasil dikirim balik lewat driver, diterima gudang
    const back = await createHandover({ kind: "KEMBALI", pointId: bmr.id, driverId: driver.id, lines: [{ itemId: jadi.id, qty: 50 }] }, actor);
    await expect(receiveHandover(back.id, actor, coordScope)).rejects.toThrow(/gudang/);
    await receiveHandover(back.id, actor, all);
    const wip = (await prisma.setting.findUniqueOrThrow({ where: { key: "loc_wip" } })).value;
    expect(await at(jadi.id, wip)).toBe(50);

    // Upah: pekerja 30, koordinator 15, driver 15 per pcs
    const rs = await prisma.boronganResult.findMany({ where: { pointId: bmr.id, settlementId: null }, include: { worker: true, coordinator: true, driver: true } });
    const pl = payLines(rs);
    expect(pl.map((l) => [l.name, l.amount])).toEqual([["Tetangga Dua", 300], ["Tetangga Satu", 1200], ["Bu Koordinator BMR", 750], ["Cak Ed Driver", 750]]);
    const st = await settlePoint({ pointId: bmr.id, upTo: date, bankAccountId: seabank }, actor);
    expect(Number(st.total)).toBe(3000);
    const sj = await prisma.journal.findUniqueOrThrow({ where: { id: st.journalId! }, include: { lines: { include: { account: true } } } });
    expect(sj.lines.find((l) => l.account.code === COA.BEBAN_TRANSPORT)?.debit.toString()).toBe("750");
    expect(sj.lines.find((l) => l.account.code === COA.BEBAN_GAJI_PRODUKSI)?.debit.toString()).toBe("2250");
    await expect(settlePoint({ pointId: bmr.id, upTo: date, bankAccountId: seabank }, actor)).rejects.toThrow(/belum dibayar/);
    await expect(deleteResult(r1.id, actor, all)).rejects.toThrow(/dibayar/);

    // Pekerja dengan riwayat hanya dinonaktifkan
    expect(await removePerson(w1.id, actor, coordScope)).toBe("nonaktif");
    const tmp = await savePerson({ name: "Belum Kerja", role: "PEKERJA", pointId: bmr.id }, actor, coordScope);
    expect(await removePerson(tmp.id, actor, coordScope)).toBe("dihapus");
  });
});
