import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { postJournal } from "@/lib/accounting";
import { koreksiUtangAwal, planUtangAwal } from "@/lib/utangAwal";

const tag = `UA${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
const year = 3400 + Math.floor(Math.random() * 50);
const date = new Date(`${year}-04-10T05:00:00Z`);

describe("Utang awal (di balik flag, pratinjau dulu)", () => {
  it("rincian utang Dr persediaan, angsuran ber-UTG, utang tanpa catatan; pratinjau tidak mengubah; koreksi idempoten", async () => {
    const store = await prisma.store.findFirstOrThrow();
    const vendorA = `Supplier Contoh${tag}`, vendorB = `Pihak Lain${tag}`;
    const jurnal = (src: string, id: string, dr: string, cr: string, amt: number, desc: string) =>
      prisma.$transaction((tx) => postJournal(tx, { date, storeId: store.id, description: desc, source: src, sourceId: id, actor, lines: [{ accountCode: dr, debit: amt }, { accountCode: cr, credit: amt }] }));
    const ju = await jurnal("UTANG", `UTG-${tag}`, "1-1401", "2-1100", 3_000_000, `Hutang UTG-${tag} ${vendorA}`);
    const p = await prisma.payable.create({ data: { number: `UTG-${tag}`, kind: "USAHA", vendor: vendorA, storeId: store.id, date, amount: 3_000_000n, journalId: ju.id } });
    const mkTx = async (n: string, text: string, amt: number) => {
      const t = await prisma.financeTransaction.create({ data: { number: `TRX-${tag}-${n}`, direction: "KELUAR", amount: BigInt(amt), date, status: "DIBUKUKAN", source: "MANUAL", fingerprint: `fp-${tag}-${n}`, createdBy: "uji", note: text } });
      const j = await jurnal("FINANCE", t.id, "1-1401", "1-1100", amt, `Uji ${tag}`);
      await prisma.financeTransaction.update({ where: { id: t.id }, data: { journalId: j.id } });
      return t.number;
    };
    const ang = await mkTx("A", `Cicilan utang ${vendorA}`, 2_000_000);
    const orphan = await mkTx("B", `Cicilan utang ${vendorB}`, 1_400_000);

    const plan = await planUtangAwal(prisma);
    expect(plan.utang.find((u) => u.number === p.number)).toMatchObject({ nominalPersediaan: 3_000_000, akun: "1-1401", sudahDikoreksi: false });
    expect(plan.angsuran.find((a) => a.txNumber === ang)).toMatchObject({ utg: p.number, nominal: 2_000_000 });
    expect(plan.tanpaCatatan.some((t) => t.txNumber === orphan)).toBe(true);
    expect(plan.angsuran.some((a) => a.txNumber === orphan)).toBe(false);

    // pratinjau (tanpa --jalankan) tidak menyimpan apa pun
    const j0 = await prisma.journal.count({ where: { source: "REKON_PERSEDIAAN" } });
    const pre = await koreksiUtangAwal(prisma, false, { utangAwal: "ekuitas", angsuran: "ya" });
    expect(pre.lines.some((l) => l.sourceId === `UTANG-AWAL:${p.number}`)).toBe(true);
    expect(await prisma.journal.count({ where: { source: "REKON_PERSEDIAAN" } })).toBe(j0);
    // tanpa opsi tidak ada baris koreksi
    expect((await koreksiUtangAwal(prisma, false, {})).lines).toEqual([]);

    // koreksi utang awal → ekuitas (Dr 3-9000 / Cr 1-1401), idempoten
    await koreksiUtangAwal(prisma, true, { utangAwal: "ekuitas" });
    const js = await prisma.journal.findMany({ where: { source: "REKON_PERSEDIAAN", sourceId: `UTANG-AWAL:${p.number}` }, include: { lines: { include: { account: true } } } });
    expect(js).toHaveLength(1);
    expect(js[0].lines.find((l) => l.account.code === "3-9000")?.debit).toBe(3_000_000n);
    expect(js[0].lines.find((l) => l.account.code === "1-1401")?.credit).toBe(3_000_000n);
    await koreksiUtangAwal(prisma, true, { utangAwal: "ekuitas" });
    expect(await prisma.journal.count({ where: { source: "REKON_PERSEDIAAN", sourceId: `UTANG-AWAL:${p.number}` } })).toBe(1);

    // angsuran → Dr 2-1100 / Cr persediaan + UTG ditandai terbayar, Finance ditautkan
    await koreksiUtangAwal(prisma, true, { angsuran: "ya" });
    const after = await prisma.payable.findUniqueOrThrow({ where: { id: p.id } });
    expect(Number(after.paid)).toBe(2_000_000);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { number: ang } })).payableId).toBe(p.id);
    expect(await prisma.journal.count({ where: { source: "REKON_PERSEDIAAN", sourceId: `UTANG-ANGSURAN:${ang}` } })).toBe(1);
    await koreksiUtangAwal(prisma, true, { angsuran: "ya" });
    expect(Number((await prisma.payable.findUniqueOrThrow({ where: { id: p.id } })).paid)).toBe(2_000_000);
    // utang tanpa catatan tidak pernah dikoreksi
    expect(await prisma.journal.count({ where: { source: "REKON_PERSEDIAAN", sourceId: `UTANG-ANGSURAN:${orphan}` } })).toBe(0);
  });
});
