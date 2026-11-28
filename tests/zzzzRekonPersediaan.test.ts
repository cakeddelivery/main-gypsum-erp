import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { postJournal } from "@/lib/accounting";
import { locationSettings, recordMovement } from "@/lib/stock";
import { koreksiRekonPersediaan, rekonPersediaan, rencanaKoreksi } from "@/lib/rekonPersediaan";
import { kandidatTransaksiKembar, pairKey, tandaiBukanDobel } from "@/lib/bukanDobel";

const tag = `RK${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
const year = 2100 + Math.floor(Math.random() * 40);
const created: string[] = [];
afterAll(async () => { await prisma.item.updateMany({ where: { id: { in: created } }, data: { active: false } }); });

const mkTx = async (number: string, extra: Record<string, unknown> = {}) =>
  prisma.financeTransaction.create({ data: { number, direction: "KELUAR", amount: 500_000n, date: new Date(`${year}-02-10T05:00:00Z`), status: "DIBUKUKAN", source: "MANUAL", fingerprint: `fp-${number}`, createdBy: "uji", ...extra } });
const bookInventory = async (txId: string, amount: number) => {
  await prisma.$transaction(async (tx) => {
    const store = await tx.store.findFirstOrThrow();
    const j = await postJournal(tx, { date: new Date(`${year}-02-10T05:00:00Z`), storeId: store.id, description: `Uji ${tag}`, source: "FINANCE", sourceId: txId, actor, lines: [{ accountCode: "1-1401", debit: amount }, { accountCode: "1-1100", credit: amount }] });
    await tx.financeTransaction.update({ where: { id: txId }, data: { journalId: j.id } });
  });
};
const sumLines = async (code: string, memo: string) => {
  const ls = await prisma.journalLine.findMany({ where: { memo, journal: { source: "REKON_PERSEDIAAN" }, account: { code } } });
  return ls.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0);
};

describe("Rekonsiliasi persediaan", () => {
  it("transaksi Finance debit persediaan tanpa stok masuk terdeteksi; yang ada penerimaannya tidak; keputusan diperlukan; koreksi idempoten", async () => {
    const tanpa = await mkTx(`TRX-${tag}-A`);
    await bookInventory(tanpa.id, 500_000);
    const dgn = await mkTx(`TRX-${tag}-B`, { amount: 300_000n });
    await bookInventory(dgn.id, 300_000);
    const item = await prisma.item.create({ data: { sku: `${tag}-BB`, name: `Bahan uji ${tag}`, unit: "kg", type: "BAHAN_BAKU", category: "Bahan Baku Utama" } });
    created.push(item.id);
    const { raw } = await locationSettings(prisma);
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: item.id, qty: 30, toLocationId: raw!, unitCost: 10_000, ref: dgn.number }, actor));

    const r = await rekonPersediaan(prisma);
    const mine = r.rows.filter((x) => x.ref.includes(tag));
    expect(mine.map((x) => [x.kelompok, x.ref, x.gap])).toEqual([["FINANCE_TANPA_STOK", `TRX-${tag}-A`, 500_000]]);
    expect(mine[0].usul).toMatch(/penerimaan stok.*reklas/);

    // Tanpa keputusan: tidak ada jurnal untuk baris ini, kelompok ditandai belum diputuskan
    const plan0 = await rencanaKoreksi(prisma, {});
    expect(plan0.belumDiputuskan).toContain("FINANCE_TANPA_STOK");
    expect(plan0.lines.some((l) => l.ref === `TRX-${tag}-A`)).toBe(false);

    const gl0 = (await rekonPersediaan(prisma)).accounts.find((a) => a.code === "1-1401")!.gl;
    const pre = await koreksiRekonPersediaan(prisma, false, { financeTanpaStok: "beban-pemakaian" });
    expect(pre.plan.lines.find((l) => l.ref === `TRX-${tag}-A`)).toMatchObject({ account: "1-1401", amount: 500_000 });
    expect(pre.journalId).toBeNull();
    expect((await rekonPersediaan(prisma)).accounts.find((a) => a.code === "1-1401")!.gl).toBe(gl0); // pratinjau tidak mengubah

    const done = await koreksiRekonPersediaan(prisma, true, { financeTanpaStok: "beban-pemakaian" });
    expect(done.journalId).toBeTruthy();
    const j = await prisma.journal.findUniqueOrThrow({ where: { id: done.journalId! }, include: { lines: true } });
    expect(j.lines.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0)).toBe(0);
    expect(await sumLines("1-1401", `REKON:FINANCE_TANPA_STOK:TRX-${tag}-A`)).toBe(-500_000);
    const acc = await prisma.coaAccount.findUniqueOrThrow({ where: { code: "1-1401" } });
    const delta = j.lines.filter((l) => l.accountId === acc.id).reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0);
    expect((await rekonPersediaan(prisma)).accounts.find((a) => a.code === "1-1401")!.gl).toBe(gl0 + delta); // buku besar berubah persis sebesar jurnal penyesuaian
    expect((await rekonPersediaan(prisma)).rows.some((x) => x.ref === `TRX-${tag}-A`)).toBe(false); // baris selesai
    const again = await koreksiRekonPersediaan(prisma, true, { financeTanpaStok: "beban-pemakaian" });
    expect(again.plan.lines.some((l) => l.ref === `TRX-${tag}-A`)).toBe(false); // idempoten
    // transaksi asli tidak dihapus
    expect(await prisma.financeTransaction.count({ where: { id: tanpa.id } })).toBe(1);
  });

  it("penerimaan stok tanpa jurnal → Dr persediaan / Cr Ekuitas saldo awal (atas keputusan), idempoten", async () => {
    const item = await prisma.item.create({ data: { sku: `${tag}-BJ`, name: `Bahan jurnal uji ${tag}`, unit: "kg", type: "BAHAN_BAKU", category: "Bahan Baku Utama" } });
    created.push(item.id);
    const { raw } = await locationSettings(prisma);
    const ref = `ZZ-${tag}`;
    await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: item.id, qty: 50, toLocationId: raw!, unitCost: 2_000, ref }, actor));
    const row = (await rekonPersediaan(prisma)).rows.find((x) => x.ref === ref)!;
    expect(row).toMatchObject({ kelompok: "PENERIMAAN_TANPA_JURNAL", account: "1-1401", gap: -100_000 });
    await koreksiRekonPersediaan(prisma, true, { penerimaanTanpaJurnal: "saldo-awal" });
    expect(await sumLines("1-1401", `REKON:PENERIMAAN_TANPA_JURNAL:${ref}`)).toBe(100_000);
    const ek = await prisma.journalLine.findMany({ where: { memo: `REKON:PENERIMAAN_TANPA_JURNAL:${ref}`, account: { code: "3-9000" } } });
    expect(ek.reduce((a, l) => a + Number(l.credit), 0)).toBe(100_000);
    expect((await rekonPersediaan(prisma)).rows.some((x) => x.ref === ref)).toBe(false);
  });
});

describe("Tandai bukan dobel (permanen)", () => {
  it("pasangan kembar muncul sebagai kandidat; setelah ditandai tidak muncul lagi; urutan bebas; idempoten; nomor salah ditolak", async () => {
    const mk = (n: string) => prisma.financeTransaction.create({ data: { number: n, direction: "TRANSFER", amount: 750_000n, accountId: `acc-${tag}`, toAccountId: `to-${tag}`, date: new Date(`${year}-03-01T05:00:00Z`), status: "DIBUKUKAN", source: "MANUAL", fingerprint: `fpk-${tag}`, createdBy: "uji" } });
    const a = await mk(`TRX-${tag}-K1`);
    const b = await mk(`TRX-${tag}-K2`);
    const has = async () => (await kandidatTransaksiKembar(prisma)).some((k) => [k.a, k.b].sort().join() === [a.number, b.number].sort().join());
    expect(await has()).toBe(true);
    expect(pairKey(b.number, a.number)).toEqual([a.number, b.number]);
    const pre = await tandaiBukanDobel(prisma, b.number, a.number, "uji", "tes", false);
    expect(pre.already).toBe(false);
    expect(await has()).toBe(true); // pratinjau tidak menyimpan
    await tandaiBukanDobel(prisma, b.number, a.number, "Dikonfirmasi owner", "tes", true);
    expect(await has()).toBe(false);
    expect((await tandaiBukanDobel(prisma, a.number, b.number, null, "tes", true)).already).toBe(true);
    expect(await prisma.duplicateDismissal.count({ where: { keyA: pairKey(a.number, b.number)[0] } })).toBe(1);
    await expect(tandaiBukanDobel(prisma, a.number, "TRX-TIDAK-ADA", null, "tes", true)).rejects.toThrow(/tidak ditemukan/);
    // transaksi tetap ada (tidak diubah / dihapus)
    expect(await prisma.financeTransaction.count({ where: { id: { in: [a.id, b.id] } } })).toBe(2);
  });
});
