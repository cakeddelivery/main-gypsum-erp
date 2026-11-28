import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { postJournal } from "@/lib/accounting";
import { biayaLpgPerPeriode } from "@/lib/biayaOven";
import { isLpgText, lpgShare, parseRupiah } from "@/lib/lpgText";
import { koreksiRekonPersediaan, rekonPersediaan } from "@/lib/rekonPersediaan";
import { overheadBulanan } from "@/lib/overheadFullCost";

const tag = `LG${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
const year = 2150 + Math.floor(Math.random() * 40);
afterAll(async () => { await prisma.item.updateMany({ where: { sku: { startsWith: tag } }, data: { active: false } }); });

describe("Teks LPG", () => {
  it("nominal dari teks & pembagian baris campur", () => {
    expect(isLpgText("Beli Lpg 2 tabung")).toBe(true);
    expect(isLpgText("beli kopi")).toBe(false);
    expect(parseRupiah("Beli LPG 3 tabung 60rb")).toBe(60000);
    expect(parseRupiah("Lpg 2 tabung = 40.000")).toBe(40000);
    expect(parseRupiah("gas Rp 1,5jt")).toBe(1_500_000);
    expect(lpgShare("Beli Lpg 2 tabung", 40000)).toEqual({ mode: "penuh", amount: 40000 });
    expect(lpgShare("Beli LPG 3 tabung 60rb, kopi 15rb, angkut 20rb", 95000)).toMatchObject({ mode: "baris", amount: 60000 });
    expect(lpgShare("Beli LPG 3 tabung\nkopi 15rb", 95000)).toMatchObject({ mode: "tidak-terparse" });
    expect(lpgShare("beli kopi", 15000)).toEqual({ mode: "tidak-lpg" });
  });
});

const mkTx = (number: string, note: string, amount: number, extra: Record<string, unknown> = {}) =>
  prisma.financeTransaction.create({ data: { number, direction: "KELUAR", amount: BigInt(amount), date: new Date(`${year}-04-10T05:00:00Z`), status: "DIBUKUKAN", source: "MANUAL", fingerprint: `fp-${number}`, createdBy: "uji", note, ...extra } });

describe("Biaya LPG dari transaksi Finance", () => {
  it("dikenali dari deskripsi (penuh / baris campur), peringatan bila tak terbaca, estimasi belum-dipasangkan tidak dobel, aktual dipakai", async () => {
    await mkTx(`TRX-${tag}-1`, "Beli Lpg 2 tabung", 40_000);
    await mkTx(`TRX-${tag}-2`, "Beli LPG 3 tabung 60rb, kopi 15rb, angkut 20rb", 95_000);
    await mkTx(`TRX-${tag}-3`, "Beli LPG 1 tabung\nkopi", 50_000);
    await mkTx(`TRX-${tag}-4`, "beli kopi", 15_000);
    // isi ulang fisik belum dipasangkan → estimasi, tetapi ada aktual Finance → tidak dijumlahkan
    // harga tabung terakhir tersedia (tanggal lama agar tidak menggeser "harga terakhir" milik tes lain)
    await prisma.lpgRefill.create({ data: { reportId: `${tag}-P`, physicalDate: new Date("2001-01-01T00:00:00Z"), tabung: 1, status: "DIPASANGKAN", amount: 190_000n, pricePerTabung: 190_000n } });
    await prisma.lpgRefill.create({ data: { reportId: `${tag}-W`, physicalDate: new Date(`${year}-04-11T00:00:00Z`), tabung: 2 } });
    const per = await biayaLpgPerPeriode(prisma, new Date(`${year}-04-20T05:00:00Z`));
    const bln = per[5];
    const mine = bln.lpg.financeBaris.filter((b) => b.number.includes(tag)).sort((a, b) => a.number.localeCompare(b.number));
    expect(mine.map((b) => [b.number.slice(-1), b.amount, b.mode])).toEqual([["1", 40_000, "penuh"], ["2", 60_000, "baris"]]);
    expect(bln.lpg.catatan.join("\n")).toMatch(new RegExp(`TRX-${tag}-3.*tidak terbaca`));
    expect(bln.lpg.financeLpg).toBeGreaterThanOrEqual(100_000);
    expect(bln.lpg.dipakai).toBe(bln.lpg.isiUlangDibayar + bln.lpg.financeLpg); // estimasi menunggu tidak ikut
    expect(bln.lpg.catatan.join("\n")).toMatch(/TIDAK dijumlahkan.*transaksi Finance LPG/);
    // aktual ikut cek:overhead-bulanan (overhead kategori LPG)
    const it = await prisma.item.create({ data: { sku: `${tag}-OH`, name: `SJ uji ${tag}`, unit: "pcs", type: "BARANG_DALAM_PROSES", category: "Barang Setengah Jadi" } });
    const oh = await prisma.overhead.create({ data: { category: "LPG", name: `LPG ${tag}`, monthlyAmount: 1n, outputPerMonth: 100 } });
    await prisma.recipeOverhead.create({ data: { itemId: it.id, overheadId: oh.id, factor: 1 } });
    const row = (await overheadBulanan(prisma, new Date(`${year}-04-20T05:00:00Z`)))[5].rows.find((r) => r.overheadId === oh.id)!;
    expect(row.aktual).toBe(bln.lpg.dipakai);
  });
});

describe("Rekonsiliasi: pembelian LPG → beban LPG", () => {
  it("baris FINANCE_TANPA_STOK ber-LPG direklas ke akun beban LPG (otomatis), sisanya menunggu keputusan; idempoten", async () => {
    // Akun beban LPG: pakai yang ada, atau buat satu (akun dibagi antar-run karena DB uji dipakai bersama)
    if (!(await prisma.coaAccount.findFirst({ where: { type: "BEBAN", name: { contains: "LPG", mode: "insensitive" } } }))) await prisma.coaAccount.create({ data: { code: "6-9777", name: "Beban LPG uji", type: "BEBAN" } });
    const mk = async (n: string, note: string, amount: number) => {
      const t = await mkTx(n, note, amount, { date: new Date(`${year}-05-10T05:00:00Z`) });
      await prisma.$transaction(async (tx) => {
        const store = await tx.store.findFirstOrThrow();
        const j = await postJournal(tx, { date: new Date(`${year}-05-10T05:00:00Z`), storeId: store.id, description: `Uji ${tag}`, source: "FINANCE", sourceId: t.id, actor, lines: [{ accountCode: "1-1401", debit: amount }, { accountCode: "1-1100", credit: amount }] });
        await tx.financeTransaction.update({ where: { id: t.id }, data: { journalId: j.id } });
      });
      return t;
    };
    await mk(`TRX-${tag}-L1`, "Beli Lpg 2 tabung", 40_000);
    await mk(`TRX-${tag}-L2`, "Beli LPG 3 tabung 60rb, kopi 15rb, angkut 20rb", 95_000);
    await mk(`TRX-${tag}-L3`, "beli bahan lain", 25_000);
    const r = await rekonPersediaan(prisma);
    const lpgAcc = r.lpgAccount!;
    expect(lpgAcc).toBeTruthy();
    const row = (n: string) => r.rows.find((x) => x.ref === `TRX-${tag}-${n}`)!;
    expect([row("L1").lpgPart, row("L2").lpgPart, row("L3").lpgPart]).toEqual([40_000, 60_000, undefined]);

    const done = await koreksiRekonPersediaan(prisma, true, {}); // tanpa keputusan: hanya baris LPG yang dikoreksi
    expect(done.plan.belumDiputuskan).toContain("FINANCE_TANPA_STOK"); // sisa L2 (35rb) & L3 belum diputuskan
    const j = await prisma.journal.findUniqueOrThrow({ where: { id: done.journalId! }, include: { lines: { include: { account: true } } } });
    const mine = j.lines.filter((l) => l.memo?.includes(tag));
    const lpgLines = mine.filter((l) => l.account.code === lpgAcc.code);
    expect(lpgLines.reduce((a, l) => a + Number(l.debit), 0)).toBe(100_000); // 40.000 + 60.000
    expect(mine.some((l) => l.memo?.includes("-L3"))).toBe(false);
    const after = await rekonPersediaan(prisma);
    expect(after.rows.find((x) => x.ref === `TRX-${tag}-L1`)).toBeUndefined();
    expect(after.rows.find((x) => x.ref === `TRX-${tag}-L2`)?.gap).toBe(35_000);
    expect(after.rows.find((x) => x.ref === `TRX-${tag}-L2`)?.lpgPart).toBeUndefined(); // bagian LPG sudah dikoreksi, tidak dobel
    const again = await koreksiRekonPersediaan(prisma, true, {});
    expect(again.plan.lines.filter((l) => l.ref.includes(tag))).toHaveLength(0); // idempoten
  });
});
