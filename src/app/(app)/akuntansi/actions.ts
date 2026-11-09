"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { autoCode } from "@/lib/codes";
import { action, str, optStr, int } from "@/lib/action";
import { audit } from "@/lib/audit";
import { closePeriod, postJournal, reverseJournal, COA, type LineInput } from "@/lib/accounting";
import { nextNumber } from "@/lib/numbering";
import { jakartaDateTime, todayStr } from "@/lib/time";
import { ForbiddenError } from "@/lib/auth";
import { balanceAdjustmentLines, bankBalancesAt, bookPayablePayment } from "@/lib/finance";
import { createLoanRecord } from "@/lib/payables";
import { resolveSupplier } from "@/lib/suppliers";
import { saveProof } from "@/lib/storage";
import { paySale } from "@/lib/sales";

/** Foto/PDF nota atau bukti transfer dari form (opsional) */
async function proofOf(fd: FormData): Promise<{ path: string; mime: string } | null> {
  const file = fd.get("proof");
  if (!(file && typeof file === "object" && "arrayBuffer" in file && file.size > 0)) return null;
  if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) throw new Error("Bukti harus JPG, PNG, WEBP, atau PDF");
  return { path: await saveProof(Buffer.from(await file.arrayBuffer()), file.type), mime: file.type };
}
import type { AccountType } from "@prisma/client";

const d = (fd: FormData, k = "date") => jakartaDateTime(str(fd, k) || todayStr(), "12:00");

export const manualJournal = action(
  "accounting.post",
  async (fd, user) => {
    const acc = fd.getAll("acc").map(String);
    const deb = fd.getAll("debit").map((x) => Number(String(x).replace(/\./g, "") || 0));
    const cre = fd.getAll("credit").map((x) => Number(String(x).replace(/\./g, "") || 0));
    const memo = fd.getAll("memo").map(String);
    const lines: LineInput[] = acc.map((a, i) => ({ accountId: a, debit: deb[i] || 0, credit: cre[i] || 0, memo: memo[i] || undefined })).filter((l) => l.accountId && (l.debit || l.credit));
    const j = await prisma.$transaction((tx) =>
      postJournal(tx, { date: d(fd), storeId: optStr(fd, "storeId"), description: z.string().min(3, "Keterangan wajib").parse(str(fd, "description")), source: str(fd, "source") === "PENYESUAIAN" ? "PENYESUAIAN" : "MANUAL", actor: user, lines }),
    );
    return `Jurnal ${j.number} dibukukan`;
  },
  ["/akuntansi"],
);

export const reverse = action(
  "accounting.post",
  async (fd, user) => {
    const j = await prisma.$transaction((tx) => reverseJournal(tx, str(fd, "id"), d(fd), user, str(fd, "reason") || "Koreksi"));
    return `Jurnal pembalik ${j.number} dibuat`;
  },
  ["/akuntansi"],
);

export const saveCoa = action(
  "accounting.post",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const data = { name: z.string().min(3).parse(str(fd, "name")), type: str(fd, "type") as AccountType, isCash: fd.get("isCash") === "on", active: id ? fd.get("active") === "on" : true };
    // Kode akun otomatis: digit tipe + kelompok berikutnya (6-2000); kode lama tidak diubah karena dipakai jurnal sistem
    const a = id ? await prisma.coaAccount.update({ where: { id }, data }) : await prisma.coaAccount.create({ data: { ...data, code: await autoCode.coa(prisma, data.type) } });
    await audit(user, id ? "AKUN_COA_DIUBAH" : "AKUN_COA_DIBUAT", "CoaAccount", a.id, data);
    return "Akun tersimpan";
  },
  ["/akuntansi/coa"],
);

export const openingBalance = action(
  "accounting.post",
  async (fd, user) => {
    const acc = fd.getAll("acc").map(String);
    const amt = fd.getAll("amount").map((x) => Number(String(x).replace(/\./g, "") || 0));
    const accounts = await prisma.coaAccount.findMany({ where: { id: { in: acc.filter(Boolean) } } });
    const lines: LineInput[] = [];
    let net = 0;
    acc.forEach((a, i) => {
      const account = accounts.find((x) => x.id === a);
      const v = amt[i];
      if (!account || !v) return;
      // Nominal dimasukkan sesuai saldo normal akun
      const debitNormal = (account.type === "ASET" && account.code !== COA.AKUM_PENYUSUTAN) || account.type === "BEBAN" || account.type === "HPP";
      const debit = debitNormal === v > 0;
      lines.push({ accountId: a, debit: debit ? Math.abs(v) : 0, credit: debit ? 0 : Math.abs(v) });
      net += debit ? Math.abs(v) : -Math.abs(v);
    });
    if (!lines.length) throw new Error("Isi minimal satu saldo");
    if (net !== 0) lines.push({ accountCode: COA.EKUITAS_SALDO_AWAL, debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0, memo: "Penyeimbang saldo awal" });
    const j = await prisma.$transaction((tx) => postJournal(tx, { date: d(fd), storeId: optStr(fd, "storeId"), description: "Saldo awal", source: "SALDO_AWAL", actor: user, lines }));
    return `Saldo awal dibukukan (${j.number})`;
  },
  ["/akuntansi"],
);

export const createReceivable = action(
  "accounting.post",
  async (fd, user) => {
    const amount = int(fd, "amount");
    if (amount <= 0) throw new Error("Nominal harus > 0");
    await prisma.$transaction(async (tx) => {
      const number = await nextNumber(tx, "PIU");
      const j = await postJournal(tx, { date: d(fd), storeId: optStr(fd, "storeId"), description: `Piutang ${number} ${str(fd, "customer")}`, source: "PIUTANG", sourceId: number, actor: user, lines: [{ accountCode: COA.PIUTANG, debit: amount }, { accountId: str(fd, "revenueAccountId"), credit: amount }] });
      await tx.receivable.create({ data: { number, customer: z.string().min(2, "Pelanggan wajib").parse(str(fd, "customer")), storeId: j.storeId, date: d(fd), dueDate: optStr(fd, "dueDate") ? d(fd, "dueDate") : null, amount: BigInt(amount), note: optStr(fd, "note"), journalId: j.id } });
    });
    return "Piutang dicatat";
  },
  ["/akuntansi/piutang-utang"],
);

export const createPayable = action(
  "accounting.post",
  async (fd, user) => {
    const amount = int(fd, "amount");
    if (amount <= 0) throw new Error("Nominal harus > 0");
    const proof = await proofOf(fd);
    await prisma.$transaction(async (tx) => {
      const number = await nextNumber(tx, "UTG");
      // Supplier dipilih dari master, atau nama yang diketik dicocokkan dulu (termasuk nama lain) agar tidak dobel
      const supplier = await resolveSupplier(tx, { supplierId: optStr(fd, "supplierId"), name: str(fd, "vendor") }, user, "hutang");
      if (!supplier) throw new Error("Pemasok wajib diisi");
      const supplierId = supplier.id;
      const vendor = supplier.name;
      const debit = await tx.coaAccount.findUniqueOrThrow({ where: { id: str(fd, "debitAccountId") } });
      // Hutang supplier = barang/jasa yang diterima: persediaan, aset, atau beban; bukan piutang/kas/hutang
      if (debit.isCash || debit.code.startsWith("1-13") || !["ASET", "BEBAN", "HPP"].includes(debit.type)) throw new Error("Akun debit harus persediaan, aset, atau beban (barang/jasa yang diterima dari supplier)");
      const j = await postJournal(tx, { date: d(fd), storeId: optStr(fd, "storeId"), description: `Hutang ${number} ${vendor}`, source: "UTANG", sourceId: number, actor: user, lines: [{ accountId: str(fd, "debitAccountId"), debit: amount }, { accountCode: COA.UTANG_USAHA, credit: amount }] });
      await tx.payable.create({ data: { number, vendor, supplierId, storeId: j.storeId, date: d(fd), dueDate: optStr(fd, "dueDate") ? d(fd, "dueDate") : null, amount: BigInt(amount), note: optStr(fd, "note"), journalId: j.id, proofPath: proof?.path ?? null, proofMime: proof?.mime ?? null } });
    });
    return "Hutang dicatat";
  },
  ["/akuntansi/piutang-utang", "/supplier"],
);

/** Pinjaman modal baru (uang masuk ke rekening, potongan pencairan → beban) atau pinjaman lama (saldo awal) */
export const createLoan = action(
  "accounting.post",
  async (fd, user) => {
    const old = str(fd, "bankAccountId") === "LAMA";
    const p = await createLoanRecord(
      {
        lender: z.string().min(2, "Pemberi pinjaman wajib").parse(str(fd, "vendor")),
        amount: int(fd, "amount"),
        date: d(fd),
        dueDate: optStr(fd, "dueDate") ? d(fd, "dueDate") : null,
        note: optStr(fd, "note"),
        storeId: optStr(fd, "storeId"),
        coaAccountId: optStr(fd, "coaAccountId"),
        bankAccountId: old ? null : str(fd, "bankAccountId"),
        received: old || !str(fd, "received") ? null : int(fd, "received"),
        paidBefore: old ? int(fd, "paidBefore") : null,
        installments: str(fd, "installments") ? int(fd, "installments") : null,
        interestTotal: str(fd, "interestTotal") ? int(fd, "interestTotal") : null,
      },
      user,
    );
    await audit(user, "PINJAMAN_DICATAT", "Payable", p.id, { number: p.number, vendor: p.vendor, amount: p.amount, paid: p.paid });
    return `Pinjaman ${p.number} dicatat`;
  },
  ["/akuntansi/piutang-utang"],
);

export const settle = action(
  "accounting.post",
  async (fd, user) => {
    const kind = str(fd, "kind");
    const id = str(fd, "id");
    const amount = int(fd, "amount");
    if (kind !== "piutang") {
      // Nominal = pokok; bunga/biaya ditambahkan → total keluar dari rekening. Tercatat juga di menu Transaksi
      const interest = int(fd, "interest");
      if (interest < 0) throw new Error("Bunga tidak boleh negatif");
      const proof = await proofOf(fd);
      const r = await bookPayablePayment({ payableId: id, amount: amount + interest, interest, bankAccountId: str(fd, "bankAccountId"), date: d(fd), note: optStr(fd, "note"), proofPath: proof?.path ?? null, proofMime: proof?.mime ?? null }, "MANUAL", { id: user.id, name: user.name });
      return `Pembayaran dibukukan (${r.transaction.number})`;
    }
    // Piutang dari menu Penjualan: dicatat sebagai cicilan penjualan agar nota & sisa tagihannya ikut berubah
    const linked = await prisma.receivable.findUniqueOrThrow({ where: { id }, select: { saleId: true } });
    if (linked.saleId) {
      const proof = await proofOf(fd);
      const r = await paySale(linked.saleId, { amount, bankAccountId: str(fd, "bankAccountId"), date: d(fd), note: optStr(fd, "note"), proofPath: proof?.path ?? null, proofMime: proof?.mime ?? null }, user);
      return `Pembayaran ${r.sale.number} dibukukan${r.lunas ? " (lunas)" : ""}`;
    }
    const bank = await prisma.bankAccount.findUniqueOrThrow({ where: { id: str(fd, "bankAccountId") } });
    await prisma.$transaction(async (tx) => {
      const doc = await tx.receivable.findUniqueOrThrow({ where: { id } });
      const remaining = Number(doc.amount - doc.paid);
      if (amount <= 0 || amount > remaining) throw new Error(`Nominal harus 1 – ${remaining}`);
      const lines: LineInput[] = [{ accountId: bank.coaAccountId, debit: amount }, { accountCode: COA.PIUTANG, credit: amount }];
      await postJournal(tx, { date: d(fd), storeId: doc.storeId, description: `Pelunasan piutang ${doc.number}`, source: "PIUTANG", sourceId: doc.number, actor: user, lines });
      await tx.receivable.update({ where: { id }, data: { paid: { increment: BigInt(amount) } } });
    });
    return "Pembayaran dibukukan";
  },
  ["/akuntansi/piutang-utang", "/finance", "/supplier", "/penjualan"],
);

export const createAsset = action(
  "accounting.post",
  async (fd, user) => {
    const cost = int(fd, "cost");
    const life = int(fd, "usefulLifeMonths");
    if (cost <= 0 || life <= 0) throw new Error("Harga & umur manfaat harus > 0");
    const funding = str(fd, "funding");
    await prisma.$transaction(async (tx) => {
      let credit: LineInput;
      if (funding === "SALDO_AWAL") credit = { accountCode: COA.EKUITAS_SALDO_AWAL, credit: cost };
      else if (funding === "UTANG") credit = { accountCode: COA.UTANG_USAHA, credit: cost };
      else credit = { accountId: (await tx.bankAccount.findUniqueOrThrow({ where: { id: funding } })).coaAccountId, credit: cost };
      const name = z.string().min(2, "Nama aset wajib").parse(str(fd, "name"));
      const j = await postJournal(tx, { date: d(fd), storeId: optStr(fd, "storeId"), description: `Perolehan aset ${name}`, source: "ASET", actor: user, lines: [{ accountId: str(fd, "assetAccountId"), debit: cost }, credit] });
      await tx.fixedAsset.create({ data: { name, storeId: j.storeId, acquiredAt: d(fd), cost: BigInt(cost), usefulLifeMonths: life, residual: BigInt(int(fd, "residual")), journalId: j.id } });
    });
    return "Aset dicatat";
  },
  ["/akuntansi/aset"],
);

export const close = action(
  "accounting.close",
  async (fd, user) => {
    const y = int(fd, "year");
    const m = int(fd, "month");
    const r = await closePeriod(y, m, user);
    return r.alreadyClosed ? "Periode sudah ditutup sebelumnya" : `Periode ditutup. Penyusutan dibukukan: Rp ${r.depreciation.toLocaleString("id-ID")}`;
  },
  ["/akuntansi"],
);

export const reopen = action(
  "accounting.close",
  async (fd, user) => {
    if (user.role !== "OWNER") throw new ForbiddenError(); // membuka kembali periode hanya oleh Owner
    const reason = str(fd, "reason");
    if (reason.length < 5) throw new Error("Alasan wajib diisi");
    const y = int(fd, "year");
    const m = int(fd, "month");
    await prisma.accountingPeriod.update({ where: { year_month: { year: y, month: m } }, data: { status: "OPEN" } });
    await audit(user, "PERIODE_DIBUKA_KEMBALI", "AccountingPeriod", `${y}-${m}`, { reason });
    return "Periode dibuka kembali";
  },
  ["/akuntansi"],
);

/** Sesuaikan saldo rekening dengan saldo asli (mis. saat mulai memakai aplikasi); selisih ke Ekuitas Saldo Awal */
export const adjustBankBalances = action(
  "accounting.post",
  async (fd, user) => {
    const date = str(fd, "date") || todayStr();
    const banks = await bankBalancesAt(date);
    const rows = banks.map((b) => {
      const raw = String(fd.get(`actual_${b.id}`) ?? "").trim();
      const actual = raw === "" ? null : Number(raw.replace(/\./g, "").replace(",", "."));
      if (actual !== null && !Number.isFinite(actual)) throw new Error(`Saldo ${b.name} tidak valid`);
      return { coaAccountId: b.coaAccountId, name: b.name, book: b.balance, actual: actual === null ? null : Math.round(actual) };
    });
    const lines = balanceAdjustmentLines(rows);
    if (!lines.length) return "Semua saldo sudah sesuai, tidak ada penyesuaian";
    const j = await prisma.$transaction((tx) => postJournal(tx, { date: d(fd), storeId: optStr(fd, "storeId"), description: "Penyesuaian saldo rekening", source: "SALDO_AWAL", actor: user, lines }));
    await audit(user, "SALDO_REKENING_DISESUAIKAN", "Journal", j.id, { date, rows: rows.filter((r) => r.actual !== null) });
    return `Saldo rekening disesuaikan (${j.number})`;
  },
  ["/akuntansi", "/finance", "/"],
);
