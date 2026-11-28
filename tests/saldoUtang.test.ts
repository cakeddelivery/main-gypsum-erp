import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { postJournal } from "@/lib/accounting";
import { analisaSaldoUtang, koreksiSaldoUtang, namaCocok, parseUtangCsv } from "@/lib/saldoUtang";

// Data SINTETIS (nama & nominal rekaan). Data utang nyata tidak boleh masuk repo: dibaca dari CSV di server.
const tag = `SU${Date.now().toString(36).toUpperCase()}`;
const actor = { id: "system", name: "Tes" };
const day = (n: number) => new Date(`${3600 + Math.floor(Math.random() * 1)}-05-${String(10 + n).padStart(2, "0")}T05:00:00Z`);
const base = day(0);

describe("CSV & pencocokan nama", () => {
  it("parse: judul/komentar dilewati, alias dengan |, nominal dengan titik, jenis divalidasi", () => {
    const rows = parseUtangCsv("pihak,jenis,sisa,tanggal\n# catatan\nNama Satu|Nama Dua,supplier,1.500.000,2026-11-28\nPemberi X,modal,\"2000000\",2026-11-28\n");
    expect(rows).toEqual([
      { pihak: "Nama Satu", aliases: ["Nama Satu", "Nama Dua"], jenis: "supplier", sisa: 1_500_000, tanggal: "2026-11-28" },
      { pihak: "Pemberi X", aliases: ["Pemberi X"], jenis: "modal", sisa: 2_000_000, tanggal: "2026-11-28" },
    ]);
    expect(() => parseUtangCsv("A,lain,1,2026-11-28")).toThrow(/supplier\|modal/);
    expect(namaCocok("Cicilan utang nama dua kemarin", ["Nama Satu", "Nama Dua"])).toBe(true);
    expect(namaCocok("bayar nama tiga", ["Nama Satu"])).toBe(false);
  });
});

describe("Analisa & koreksi saldo utang (sintetis)", () => {
  const jurnal = (src: string, id: string, lines: { code: string; debit?: number; credit?: number }[], date: Date, desc: string) =>
    prisma.$transaction(async (tx) => { const st = await tx.store.findFirstOrThrow(); return postJournal(tx, { date, storeId: st.id, description: desc, source: src, sourceId: id, actor, lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit, credit: l.credit })) }); });

  it("supplier: pembayaran sebelum/sesudah UTG, efek koreksi utang-awal, reklas pembayaran yang dibukukan sebagai beban, sisa = perlu konfirmasi; idempoten", async () => {
    const nama = `Pihak Sintetis ${tag}`;
    const st = await prisma.store.findFirstOrThrow();
    const ju = await jurnal("UTANG", `UTG-${tag}A`, [{ code: "1-1401", debit: 1_000_000 }, { code: "2-1100", credit: 1_000_000 }], day(2), `Hutang ${tag}`);
    const p = await prisma.payable.create({ data: { number: `UTG-${tag}A`, kind: "USAHA", vendor: nama, storeId: st.id, date: day(2), amount: 1_000_000n, journalId: ju.id } });
    const mkTx = async (n: string, amt: number, akun: string, at: Date) => {
      const t = await prisma.financeTransaction.create({ data: { number: `TRX-${tag}-${n}`, direction: "KELUAR", amount: BigInt(amt), date: at, status: "DIBUKUKAN", source: "MANUAL", fingerprint: `fp-${tag}-${n}`, createdBy: "uji", note: `Bayar ${nama}` } });
      const j = await jurnal("FINANCE", t.id, [{ code: akun, debit: amt }, { code: "1-1100", credit: amt }], at, `Uji ${tag}`);
      await prisma.financeTransaction.update({ where: { id: t.id }, data: { journalId: j.id } });
      return t.number;
    };
    await mkTx("1", 200_000, "1-1401", day(0)); // sebelum UTG (tidak mengurangi UTG)
    await mkTx("2", 300_000, "1-1401", day(3)); // sesudah UTG, debit persediaan → mengurangi UTG setelah koreksi utang-awal
    const beban = await mkTx("3", 150_000, "6-1250", day(4)); // dibukukan sebagai beban → reklas
    const rows = parseUtangCsv(`${nama},supplier,400000,2026-11-28`);
    const [a] = await analisaSaldoUtang(prisma, rows);
    expect(a.saldoSistem).toBe(1_000_000);
    expect(a.pembayaran.find((x) => x.txNumber.endsWith("-1"))?.sebelumUtg).toBe(true);
    expect(a.pembayaran.find((x) => x.txNumber.endsWith("-2"))?.sebelumUtg).toBe(false);
    expect(a.efekKoreksiAwal).toBe(300_000);
    expect(a.saldoSetelahKoreksi).toBe(700_000);
    expect(a.selisih).toBe(300_000);
    expect(a.usulan.find((u) => u.jenis === "RECLAS_BAYAR")).toMatchObject({ amount: 150_000, txNumber: beban, akunCr: "6-1250" });
    expect(a.usulan.find((u) => u.jenis === "KONFIRMASI")?.amount).toBe(150_000);

    // pratinjau tidak menyimpan; tanpa flag tidak ada rencana
    const pre = await koreksiSaldoUtang(prisma, rows, false, { pihak: nama, reklasBayar: true });
    expect(pre.rencana).toHaveLength(1);
    expect((await koreksiSaldoUtang(prisma, rows, false, { pihak: nama })).rencana).toEqual([]);
    expect(await prisma.journal.count({ where: { sourceId: `SALDO-UTANG-REKLAS:${beban}` } })).toBe(0);
    await koreksiSaldoUtang(prisma, rows, true, { pihak: nama, reklasBayar: true });
    const j = await prisma.journal.findMany({ where: { sourceId: `SALDO-UTANG-REKLAS:${beban}` }, include: { lines: { include: { account: true } } } });
    expect(j).toHaveLength(1);
    expect(j[0].lines.find((l) => l.account.code === "2-1100")?.debit).toBe(150_000n);
    expect(j[0].lines.find((l) => l.account.code === "6-1250")?.credit).toBe(150_000n);
    expect(Number((await prisma.payable.findUniqueOrThrow({ where: { id: p.id } })).paid)).toBe(150_000);
    await koreksiSaldoUtang(prisma, rows, true, { pihak: nama, reklasBayar: true });
    expect(await prisma.journal.count({ where: { sourceId: `SALDO-UTANG-REKLAS:${beban}` } })).toBe(1);
  });

  it("supplier sistem < target → utang lama (Dr 3-9000 / Cr 2-1100 + UTG baru), idempoten; modal → saldo awal pinjaman lewat fungsi Pinjaman", async () => {
    const nama = `Pihak Kurang ${tag}`;
    const rows = parseUtangCsv(`${nama},supplier,250000,2026-11-28`);
    const [a] = await analisaSaldoUtang(prisma, rows);
    expect(a.selisih).toBe(-250_000);
    expect(a.usulan[0]).toMatchObject({ jenis: "UTANG_LAMA", amount: 250_000 });
    await koreksiSaldoUtang(prisma, rows, true, { pihak: nama, utangLama: true });
    const [b] = await analisaSaldoUtang(prisma, rows);
    expect(b.saldoSistem).toBe(250_000);
    expect(b.usulan).toEqual([]);
    expect(await prisma.journal.count({ where: { sourceId: `SALDO-UTANG-LAMA:${nama}` } })).toBe(1);
    await koreksiSaldoUtang(prisma, rows, true, { pihak: nama, utangLama: true });
    expect(await prisma.payable.count({ where: { vendor: nama } })).toBe(1);

    const modal = `Pemberi Sintetis ${tag}`;
    const mrows = parseUtangCsv(`${modal},modal,500000,2026-11-28`);
    const [m] = await analisaSaldoUtang(prisma, mrows);
    expect(m.usulan[0]).toMatchObject({ jenis: "SALDO_AWAL_MODAL", amount: 500_000 });
    await koreksiSaldoUtang(prisma, mrows, true, { pihak: modal, saldoAwalModal: true });
    const [m2] = await analisaSaldoUtang(prisma, mrows);
    expect(m2.saldoSistem).toBe(500_000);
    expect(m2.usulan).toEqual([]);
    await koreksiSaldoUtang(prisma, mrows, true, { pihak: modal, saldoAwalModal: true });
    expect(await prisma.payable.count({ where: { vendor: modal, kind: "PINJAMAN" } })).toBe(1);
  });
});
