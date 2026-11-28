import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { postJournal } from "@/lib/accounting";
import { biayaLpgPerPeriode } from "@/lib/biayaOven";
import { suggestCategory } from "@/lib/extract";
import { lpgReklas, planLpgReklas } from "@/lib/lpgReklas";
import { lpgExpenseAccount } from "@/lib/rekonPersediaan";

const tag = `BP${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
const year = 2200 + Math.floor(Math.random() * 60);
const now = new Date(`${year}-07-20T05:00:00Z`);

describe("Akun & kategori LPG Oven (BOP)", () => {
  it("migrasi/seed: 6-1310 + kategori LPG Oven; LPG menang atas kategori umum Listrik, Air & Gas; listrik tetap ke Listrik", async () => {
    const acc = await prisma.coaAccount.findUniqueOrThrow({ where: { code: "6-1310" } });
    expect(acc).toMatchObject({ type: "BEBAN", active: true });
    expect(acc.name).toMatch(/LPG Produksi/);
    const cats = await prisma.txCategory.findMany({ where: { active: true } });
    const lpg = cats.find((c) => c.name === "LPG Oven (Produksi)")!;
    expect(lpg.coaAccountId).toBe(acc.id);
    const listrik = cats.find((c) => c.name === "Listrik, Air & Gas")!;
    for (const t of ["beli lpg 2 tabung 40rb", "isi ulang gas elpiji", "tabung gas melon 3 buah", "elpiji oven"]) expect(suggestCategory(t, "KELUAR", cats)).toBe(lpg.id);
    expect(suggestCategory("bayar listrik pln 300rb", "KELUAR", cats)).toBe(listrik.id);
    expect((await lpgExpenseAccount(prisma))?.code).toBe("6-1310");
  });
});

const mkTx = async (number: string, note: string, amount: number, account: string) => {
  const t = await prisma.financeTransaction.create({ data: { number, direction: "KELUAR", amount: BigInt(amount), date: new Date(`${year}-07-10T05:00:00Z`), status: "DIBUKUKAN", source: "MANUAL", fingerprint: `fp-${number}`, createdBy: "uji", note } });
  await prisma.$transaction(async (tx) => {
    const store = await tx.store.findFirstOrThrow();
    const j = await postJournal(tx, { date: new Date(`${year}-07-10T05:00:00Z`), storeId: store.id, description: `Uji ${tag}`, source: "FINANCE", sourceId: t.id, actor, lines: [{ accountCode: account, debit: amount }, { accountCode: "1-1100", credit: amount }] });
    await tx.financeTransaction.update({ where: { id: t.id }, data: { journalId: j.id } });
  });
  return t;
};
const period = async () => (await biayaLpgPerPeriode(prisma, now))[5].lpg;

describe("LPG di buku besar 6-1310 & reklas dari beban umum", () => {
  it("transaksi kategori LPG Oven (6-1310) dihitung sekali dari buku besar, tidak dobel dengan deteksi deskripsi", async () => {
    const before = await period();
    await mkTx(`TRX-${tag}-B1`, "Beli Lpg 2 tabung", 40_000, "6-1310");
    const after = await period();
    expect(after.bopLpg - before.bopLpg).toBe(40_000);
    expect(after.financeLpg - before.financeLpg).toBe(0); // deskripsi LPG-nya tidak dihitung lagi
    expect(after.dipakai - before.dipakai).toBe(40_000);
    expect(after.financeBaris.some((b) => b.number === `TRX-${tag}-B1`)).toBe(false);
  });

  it("LPG lama di 6-1300: tampil sebagai info (akun), dihitung sekali; reklas ke 6-1310 lewat jurnal (idempoten); biaya LPG tetap sama", async () => {
    const before = await period();
    const t = await mkTx(`TRX-${tag}-B2`, "Beli Lpg 3 tabung", 60_000, "6-1300");
    const mid = await period();
    expect(mid.dipakai - before.dipakai).toBe(60_000);
    expect(mid.financeBaris.find((b) => b.number === t.number)?.akun).toBe("6-1300");
    const plan = (await planLpgReklas(prisma)).find((r) => r.number === t.number)!;
    expect(plan).toMatchObject({ amount: 60_000, akun: "6-1300" });

    const pre = await lpgReklas(prisma, false);
    expect(pre.rows.some((r) => r.number === t.number)).toBe(true);
    expect(await prisma.journal.count({ where: { source: "REKLAS_LPG", sourceId: t.id } })).toBe(0); // pratinjau tidak menyimpan

    const done = await lpgReklas(prisma, true);
    expect(done.gagal).toEqual([]);
    const j = await prisma.journal.findFirstOrThrow({ where: { source: "REKLAS_LPG", sourceId: t.id }, include: { lines: { include: { account: true } } } });
    const by = (code: string) => j.lines.filter((l) => l.account.code === code);
    expect(by("6-1310").reduce((a, l) => a + Number(l.debit), 0)).toBe(60_000);
    expect(by("6-1300").reduce((a, l) => a + Number(l.credit), 0)).toBe(60_000);
    // transaksi asli tidak diubah
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } })).journalId).toBeTruthy();
    // sesudah reklas: dihitung dari buku besar (bukan deskripsi), total biaya LPG tidak berubah
    const after = await period();
    expect(after.dipakai).toBe(mid.dipakai);
    expect(after.financeBaris.some((b) => b.number === t.number)).toBe(false);
    expect((await planLpgReklas(prisma)).some((r) => r.number === t.number)).toBe(false);
    const again = await lpgReklas(prisma, true);
    expect(again.rows.some((r) => r.number === t.number)).toBe(false);
    expect(await prisma.journal.count({ where: { source: "REKLAS_LPG", sourceId: t.id } })).toBe(1);
  });
});
