import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { postJournal } from "@/lib/accounting";
import { lpgShare, splitParts } from "@/lib/lpgText";
import { planLpgReklasFull } from "@/lib/lpgReklas";
import { diagnosaSisa, refGroup, rencanaKoreksi } from "@/lib/rekonPersediaan";

const tag = `LM${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
const year = 2300 + Math.floor(Math.random() * 60);

describe("Parser LPG: hanya nominal baris LPG", () => {
  it("'Lpg 2 tabung = 40.000 / Cleo galon 1 = 20.000' → LPG 40.000 (galon bukan LPG)", () => {
    expect(lpgShare("Lpg 2 tabung = 40.000 / Cleo galon 1 = 20.000", 60_000)).toMatchObject({ mode: "baris", amount: 40_000 });
  });
  it("'Beli Lpg 3 tabung dan bensin grand' → nominal tidak terbaca (perlu cek manual), bukan seluruh total", () => {
    expect(lpgShare("Beli Lpg 3 tabung dan bensin grand", 72_000).mode).toBe("tidak-terparse");
    // nominal bagian lain tercantum pun tidak dipakai untuk menebak LPG (total − bagian lain)
    expect(lpgShare("Beli Lpg 3 tabung dan bensin 12rb", 72_000).mode).toBe("tidak-terparse");
  });
  it("teks multi-baris (kopi, jasa angkut, teajus, kardus bekas 5rb, LPG 60rb) → LPG 60.000, bukan 5.000", () => {
    const baris = "Kopi A 60rb\nJasa angkut 10rb\nTeajus 14rb\nKardus bekas 5rb\nBeli LPG 3 tabung 60rb";
    expect(lpgShare(baris, 149_000)).toMatchObject({ mode: "baris", amount: 60_000 });
    // tanpa pemisah baris sama sekali
    expect(lpgShare(baris.replace(/\n/g, " "), 149_000)).toMatchObject({ mode: "baris", amount: 60_000 });
    expect(splitParts(baris.replace(/\n/g, " ")).map((p) => p.amount)).toEqual([60_000, 10_000, 14_000, 5_000, 60_000]);
  });
  it("satu bagian / semua bagian LPG → penuh; tanpa LPG → tidak-lpg", () => {
    expect(lpgShare("Beli LPG 3 tabung 60rb", 60_000)).toMatchObject({ mode: "penuh", amount: 60_000 });
    expect(lpgShare("Cleo galon 1 = 20.000", 20_000).mode).toBe("tidak-lpg");
  });
});

const mkTx = async (n: string, note: string, legs: { code: string; debit: number }[]) => {
  const amount = legs.reduce((a, l) => a + l.debit, 0);
  const number = `TRX-${tag}-${n}`;
  const date = new Date(`${year}-07-10T05:00:00Z`);
  const t = await prisma.financeTransaction.create({ data: { number, direction: "KELUAR", amount: BigInt(amount), date, status: "DIBUKUKAN", source: "MANUAL", fingerprint: `fp-${number}`, createdBy: "uji", note } });
  await prisma.$transaction(async (tx) => {
    const store = await tx.store.findFirstOrThrow();
    const j = await postJournal(tx, { date, storeId: store.id, description: `Uji ${tag}`, source: "FINANCE", sourceId: t.id, actor, lines: [...legs.map((l) => ({ accountCode: l.code, debit: l.debit })), { accountCode: "1-1100", credit: amount }] });
    await tx.financeTransaction.update({ where: { id: t.id }, data: { journalId: j.id } });
  });
  return number;
};

describe("Reklas LPG multi-item: hanya leg LPG yang dipindah", () => {
  it("LPG sudah di leg persediaan → leg konsumsi (galon) TIDAK direklas; teks tak terbaca → cek manual; leg beban ≥ nominal", async () => {
    const a = await mkTx("A", "Lpg 2 tabung = 40.000 / Cleo galon 1 = 20.000", [{ code: "1-1401", debit: 40_000 }, { code: "6-1250", debit: 20_000 }]); // seperti 0093
    const b = await mkTx("B", "Beli Lpg 3 tabung dan bensin grand", [{ code: "6-1200", debit: 72_000 }]); // seperti 0192
    const c = await mkTx("C", "Kopi A 60rb\nJasa angkut 10rb\nTeajus 14rb\nKardus bekas 5rb\nBeli LPG 3 tabung 60rb", [{ code: "6-1250", debit: 60_000 }, { code: "1-1401", debit: 60_000 }, { code: "6-1200", debit: 10_000 }, { code: "6-1250", debit: 19_000 }]); // seperti 0238
    const d = await mkTx("D", "Beli LPG 3 tabung 60rb dan es batu 12rb", [{ code: "6-1300", debit: 72_000 }]); // satu leg beban, hanya 60rb LPG
    const e = await mkTx("E", "Beli LPG 3 tabung 60rb, spidol 15rb", [{ code: "6-1300", debit: 60_000 }, { code: "6-1250", debit: 15_000 }]); // dua leg: yang persis 60rb
    const f = await mkTx("F", "Beli LPG 3 tabung 60rb, spidol 15rb", [{ code: "6-1300", debit: 40_000 }, { code: "6-1250", debit: 35_000 }]); // tak ada leg ≥ 60rb persis → manual
    const plan = await planLpgReklasFull(prisma);
    const row = (n: string) => plan.rows.find((r) => r.number === n);
    const man = (n: string) => plan.manual.find((r) => r.number === n);
    expect(row(a)).toBeUndefined(); // LPG 40.000 ada di persediaan
    expect(man(b)).toBeTruthy(); // nominal tak terbaca
    expect(row(b)).toBeUndefined();
    expect(row(c)).toBeUndefined(); // LPG 60.000 cocok dengan leg beban DAN leg persediaan → tidak ditebak
    expect(man(c)).toBeTruthy();
    expect(row(d)).toMatchObject({ amount: 60_000, akun: "6-1300" }); // bukan 72.000
    expect(row(e)).toMatchObject({ amount: 60_000, akun: "6-1300" });
    expect(row(f)).toBeUndefined();
    expect(man(f)).toBeTruthy();
  });
});

describe("Diagnosis sisa per jenis referensi", () => {
  it("refGroup memetakan awalan ref; diagnosaSisa memuat grup jurnal tanpa mutasi dan bagian antar-persediaan yang terbukti", async () => {
    expect(refGroup("KRM:abc")).toBe("KRM");
    expect(refGroup("BATAL LPH:x:1")).toBe("LPH");
    expect(refGroup(null)).toBe("(tanpa ref)");
    const before = await diagnosaSisa(prisma);
    const source = `UJI${tag}`;
    const date = new Date(`${year}-08-01T05:00:00Z`);
    await prisma.$transaction(async (tx) => {
      const store = await tx.store.findFirstOrThrow();
      // jenis referensi sintetis: 1-1401 lebih tinggi 7.000 dan 1-1403 lebih rendah 7.000 tanpa mutasi stok → bagian terbukti 7.000
      await postJournal(tx, { date, storeId: store.id, description: `Uji ${tag}`, source, sourceId: tag, actor, lines: [{ accountCode: "1-1401", debit: 7_000 }, { accountCode: "1-1100", credit: 7_000 }] });
      await postJournal(tx, { date, storeId: store.id, description: `Uji ${tag} b`, source, sourceId: `${tag}b`, actor, lines: [{ accountCode: "1-1100", debit: 7_000 }, { accountCode: "1-1403", credit: 7_000 }] });
    });
    const d = await diagnosaSisa(prisma);
    const g = `J:${source}`;
    expect(d.rows.find((r) => r.account === "1-1401" && r.group === g)).toMatchObject({ mutasi: 0, jurnal: 7_000, selisih: 7_000 });
    expect(d.rows.find((r) => r.account === "1-1403" && r.group === g)).toMatchObject({ mutasi: 0, jurnal: -7_000, selisih: -7_000 });
    expect(d.antar.perGrup.find((x) => x.group === g)?.amount).toBe(7_000);
    expect(d.antar.total - before.antar.total).toBe(7_000);
    // usulan koreksi (pratinjau): Cr 1-1401 / Dr 1-1403 sebesar bagian terbukti; tanpa pilihan itu tidak ada baris
    const plan = await rencanaKoreksi(prisma, { sisaAntar: "reklas-antar-persediaan" });
    const line = plan.lines.find((l) => l.kelompok === "SISA_ANTAR")!;
    expect(line).toMatchObject({ account: "1-1401", counter: "1-1403" });
    expect(line.amount).toBe(d.antar.sisa);
    expect((await rencanaKoreksi(prisma, {})).lines.some((l) => l.kelompok === "SISA_ANTAR")).toBe(false);
  });
});

import { lpgReklas } from "@/lib/lpgReklas";
import { diagnosaBarang, rekonPersediaan, rincianJurnal } from "@/lib/rekonPersediaan";
import { locationSettings, recordMovement } from "@/lib/stock";

describe("Pratinjau produksi #206: leg LPG persis, harga tabung, kunci grup", () => {
  it("TRX seperti 0238: leg 6-1300 60.000 persis (persediaan 5.000 = kardus bukan LPG) → reklas 60.000 dari 6-1300; rekon tidak menandai LPG Rp5.000", async () => {
    const text = "Kopi A 60rb\nJasa angkut 10rb\nTeajus 14rb\nKardus bekas 5rb\nBeli LPG 3 tabung 60rb";
    const n = await mkTx("G", text, [{ code: "6-1250", debit: 60_000 }, { code: "6-1200", debit: 10_000 }, { code: "6-1250", debit: 14_000 }, { code: "6-1300", debit: 60_000 }, { code: "1-1401", debit: 5_000 }]);
    const plan = await planLpgReklasFull(prisma);
    expect(plan.rows.find((r) => r.number === n)).toMatchObject({ amount: 60_000, akun: "6-1300" });
    const rekon = await rekonPersediaan(prisma);
    const row = rekon.rows.find((r) => r.ref === n && r.account === "1-1401");
    expect(row?.gap).toBe(5_000);
    expect(row?.lpgPart).toBeUndefined(); // 5.000 ≠ nominal LPG 60rb dari teks
  });

  it("TRX seperti 0192: tanpa opsi → cek manual; dengan --harga-tabung=20000 → 3 × 20.000 = 60.000 dari 6-1200", async () => {
    const n = await mkTx("H", "Beli Lpg 3 tabung dan bensin grand", [{ code: "6-1200", debit: 72_000 }]);
    const tanpa = await planLpgReklasFull(prisma);
    expect(tanpa.manual.some((m) => m.number === n)).toBe(true);
    expect(tanpa.rows.some((r) => r.number === n)).toBe(false);
    const dengan = await planLpgReklasFull(prisma, { hargaTabung: 20_000 });
    expect(dengan.rows.find((r) => r.number === n)).toMatchObject({ amount: 60_000, akun: "6-1200" });
    // pratinjau tidak menyimpan; harga tabung tidak mengubah teks yang nominalnya sudah tertulis
    expect(lpgShare("Beli LPG 3 tabung 60rb, spidol 15rb", 75_000, { hargaTabung: 20_000 })).toMatchObject({ mode: "baris", amount: 60_000 });
    expect(lpgShare("Beli Lpg 3 tabung dan bensin 12rb", 72_000, { hargaTabung: 20_000 })).toMatchObject({ mode: "baris", amount: 60_000 });
    expect((await lpgReklas(prisma, false, { hargaTabung: 20_000 })).rows.some((r) => r.number === n)).toBe(true);
    expect(await prisma.journal.count({ where: { source: "REKLAS_LPG" } })).toBeGreaterThanOrEqual(0);
  });

  it("diagnosis: PEMBELIAN↔PBL, FINANCE↔TRX, STOK_AWAL↔CUTOVER/AWAL; pembalik ikut grup asal; rincian J:<sumber> dan barang negatif", async () => {
    const date = new Date(`${year}-09-01T05:00:00Z`);
    const locs = await locationSettings(prisma);
    const item = await prisma.item.create({ data: { sku: `LMN-${tag}`, name: `Uji negatif ${tag}`, type: "BAHAN_BAKU", unit: "pcs" } as never });
    const source = `UJI${tag}Z`;
    await prisma.$transaction(async (tx) => {
      const store = await tx.store.findFirstOrThrow();
      await postJournal(tx, { date, storeId: store.id, description: `Uji ${tag}`, source: "STOK_AWAL", sourceId: `${tag}`, actor, lines: [{ accountCode: "1-1401", debit: 2_222 }, { accountCode: "3-1000", credit: 2_222 }] }).catch(async () => postJournal(tx, { date, storeId: store.id, description: `Uji ${tag}`, source: "STOK_AWAL", sourceId: `${tag}`, actor, lines: [{ accountCode: "1-1401", debit: 2_222 }, { accountCode: "1-1100", credit: 2_222 }] }));
      await postJournal(tx, { date, storeId: store.id, description: `Uji rinci ${tag}`, source, sourceId: tag, actor, lines: [{ accountCode: "1-1401", debit: 3_333 }, { accountCode: "1-1100", credit: 3_333 }] });
      // stok minus: keluar tanpa stok → barang negatif
      await recordMovement(tx, { type: "PENGELUARAN", itemId: item.id, qty: 4, fromLocationId: locs.raw!, allowNegative: true, ref: `CUTOVER-${tag}`, date, fallbackUnitCost: { value: 100, note: "uji" } }, actor);
    });
    const d = await (await import("@/lib/rekonPersediaan")).diagnosaSisa(prisma);
    expect(d.rows.some((r) => r.group === "J:FINANCE" || r.group === "J:PEMBELIAN" || r.group === "J:PEMBALIK")).toBe(false);
    expect(d.rows.some((r) => r.group === "STOK_AWAL" && r.account === "1-1401")).toBe(true);
    const rinci = await rincianJurnal(prisma, source);
    expect(rinci).toHaveLength(1);
    expect(rinci[0]).toMatchObject({ account: "1-1401", amount: 3_333 });
    const bar = await diagnosaBarang(prisma);
    const neg = bar.negatif.find((x) => x.sku === `LMN-${tag}`);
    expect(neg?.qty).toBe(-4);
    expect(neg?.lokasiNegatif[0].qty).toBe(-4);
  });
});
