import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sent: { text: string; buttons?: { text: string; callback_data: string }[][] }[] = [];
vi.mock("@/lib/telegram", async (orig) => {
  const real = await orig<typeof import("@/lib/telegram")>();
  return {
    ...real,
    sendTelegram: vi.fn(async (_c: string, text: string, o: { buttons?: { text: string; callback_data: string }[][] } = {}) => (sent.push({ text, buttons: o.buttons }), { ok: true })),
    editTelegram: vi.fn(async (_c: string, _m: number, text: string, buttons?: { text: string; callback_data: string }[][]) => (sent.push({ text, buttons }), { ok: true })),
    answerCallback: vi.fn(async () => ({ ok: true })),
    chatAction: vi.fn(async () => ({ ok: true })),
  };
});

import { prisma } from "@/lib/db";
import { handleTelegramUpdate } from "@/lib/bot";
import { bookReserveTransfer, cancelBookedTransaction, createTransaction } from "@/lib/finance";
import { cancelPurchase, createPurchase } from "@/lib/purchase";
import { cancelAdvance, giveAdvance } from "@/lib/payroll";
import { postReserve } from "@/lib/reserve";
import { cancelSale, cancelSalePayment, createSale, paySale } from "@/lib/sales";
import { mirrorJournal, originLabel } from "@/lib/txMirror";
import { findSimilar } from "@/lib/similar";
import { approveCategoryProposal, proposeCategory, rejectCategoryProposal, suggestCategories } from "@/lib/categorySuggest";
import { jakartaDateTime, todayStr } from "@/lib/time";

const TG = 777090;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = (Math.floor(Date.now() / 1000) % 1_000_000_000) + 700_000;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);
const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);
const session = () => prisma.botSession.findUnique({ where: { chatId: String(TG) } });
const btns = () => sent.at(-1)?.buttons?.flat().map((b) => b.callback_data) ?? [];
const rnd = (base: number) => base + Math.floor(Math.random() * 900) * 100;

let owner: { id: string; name: string };
let seabank: string;
let shopeepay: string;
let storeId: string;
let itemId: string;
let bankA: string;
let bankB: string;
let fundId: string;
/** Saldo buku dari jurnal (rekening uji nonaktif tidak ada di bankBalances) */
const bal = async (id: string) => {
  const b = await prisma.bankAccount.findUniqueOrThrow({ where: { id } });
  const s = await prisma.journalLine.aggregate({ where: { accountId: b.coaAccountId }, _sum: { debit: true, credit: true } });
  return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
};

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  owner = { id: u.id, name: u.name };
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true, chatId: String(TG) } });
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
  shopeepay = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SHOPEEPAY" } })).id;
  storeId = (await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } })).value;
  const sup = await prisma.supplier.upsert({ where: { code: "SUP_UJI_DUP" }, create: { code: "SUP_UJI_DUP", name: "Toko Uji Dobel" }, update: {} });
  const coa = async (code: string) => (await prisma.coaAccount.upsert({ where: { code }, create: { code, name: `Rekening Uji ${code}`, type: "ASET", isCash: true }, update: {} })).id;
  bankA = (await prisma.bankAccount.upsert({ where: { code: "UJI_DOBEL_A" }, create: { code: "UJI_DOBEL_A", name: "Rekening Uji A", coaAccountId: await coa("1-1297"), active: false }, update: {} })).id;
  bankB = (await prisma.bankAccount.upsert({ where: { code: "UJI_DOBEL_B" }, create: { code: "UJI_DOBEL_B", name: "Rekening Uji B", coaAccountId: await coa("1-1298"), active: false }, update: {} })).id;
  fundId = (await prisma.reserveFund.findFirst({ where: { name: "Dana Uji Dobel" } }))?.id ?? (await prisma.reserveFund.create({ data: { name: "Dana Uji Dobel", kind: "LOAN_SAVING", dailyAmount: BigInt(70_000), fromBankId: bankA, toBankId: bankB, storeId, active: false } })).id;
  itemId = (await prisma.item.upsert({ where: { sku: "BB-UJI-DOBEL" }, create: { sku: "BB-UJI-DOBEL", name: "Kardus Uji Dobel", type: "BAHAN_BAKU", unit: "pcs", supplierId: sup.id }, update: { active: true } })).id;
});
// Kategori & akun COA uji dihapus lagi agar kode COA otomatis di tes lain tetap sama
const createdCats: string[] = [];
afterAll(async () => {
  const cats = await prisma.txCategory.findMany({ where: { id: { in: createdCats } } });
  await prisma.financeTransaction.updateMany({ where: { categoryId: { in: createdCats } }, data: { status: "DITOLAK", categoryId: null } });
  await prisma.categoryProposal.deleteMany({ where: { categoryId: { in: createdCats } } });
  await prisma.txCategory.deleteMany({ where: { id: { in: createdCats } } });
  await prisma.coaAccount.deleteMany({ where: { id: { in: cats.map((c) => c.coaAccountId) } } });
});
beforeEach(async () => {
  await prisma.botSession.deleteMany({ where: { chatId: String(TG) } });
  sent.length = 0;
});

describe("Uang rekening dari menu lain tampil tepat sekali di Transaksi (tanpa jurnal/saldo ganda)", () => {
  it("pembelian lunas → 1 baris tertaut; dibatalkan di menu Pembelian → baris ikut Dibatalkan", async () => {
    const amt = rnd(310_000);
    const before = await bal(bankA);
    const p = await createPurchase({ storeId, vendor: "Toko Uji Dobel", date: jakartaDateTime("2032-05-11", "10:00"), term: "LUNAS", paidNow: 0, bankAccountId: bankA, lines: [{ itemId, qty: 10, amount: amt }] }, owner);
    const rows = await prisma.financeTransaction.findMany({ where: { journalId: p.journalId! } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "PEMBELIAN", originRef: p.number, status: "DIBUKUKAN", direction: "KELUAR", accountId: bankA });
    expect(Number(rows[0].amount)).toBe(amt);
    // Saldo turun sekali (jurnal tetap satu)
    expect(await bal(bankA)).toBe(before - amt);
    expect(await prisma.journal.count({ where: { OR: [{ sourceId: p.number }, { sourceId: rows[0].id }] } })).toBe(1);
    // Dipanggil ulang (skrip tautkan) tidak menambah baris
    await prisma.$transaction((tx) => mirrorJournal(tx, p.journalId!));
    expect(await prisma.financeTransaction.count({ where: { journalId: p.journalId! } })).toBe(1);
    // Baris tertaut tidak bisa dibatalkan dari menu Transaksi
    await expect(cancelBookedTransaction(rows[0].id, owner, "uji")).rejects.toThrow(/menu Pembelian/);
    await cancelPurchase(p.id, "uji batal", owner);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: rows[0].id } })).status).toBe("DIBATALKAN");
    expect(await bal(bankA)).toBe(before);
  });

  it("kasbon, sisihan, penjualan & cicilan piutang masing-masing satu baris; batal → ikut Dibatalkan", async () => {
    // Rekening & dana uji sendiri (nonaktif) agar saldo/dana sisihan tes lain tidak terganggu
    const emp = await prisma.employee.findFirstOrThrow({ where: { status: "AKTIF" } });
    const a = await giveAdvance({ employeeId: emp.id, amount: rnd(51_000), installment: 0, bankAccountId: bankA, date: "2032-05-12", note: null }, owner);
    const ka = await prisma.financeTransaction.findMany({ where: { journalId: a.journalId! } });
    expect(ka).toHaveLength(1);
    expect(ka[0]).toMatchObject({ origin: "KASBON", direction: "KELUAR", accountId: bankA });
    await cancelAdvance(a.id, "uji", owner);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: ka[0].id } })).status).toBe("DIBATALKAN");

    const before = { a: await bal(bankA), b: await bal(bankB) };
    const e = await postReserve(fundId, "2032-05-13", owner);
    const sis = await prisma.financeTransaction.findMany({ where: { journalId: e.journalId! } });
    expect(sis).toHaveLength(1);
    expect(sis[0]).toMatchObject({ origin: "SISIHAN", direction: "TRANSFER", accountId: bankA, toAccountId: bankB });
    expect(originLabel(sis[0].origin, sis[0].direction)).toBe("Sisihan otomatis");
    expect(await bal(bankB)).toBe(before.b + Number(e.amount));
    expect(await bal(bankA)).toBe(before.a - Number(e.amount));
    // Sisihan otomatis tanpa bukti bukan duplikat transfer aslinya (nanti diserap, lihat applyReserveLink)
    const hits = await findSimilar(prisma, { direction: "TRANSFER", amount: Number(e.amount), date: jakartaDateTime("2032-05-13", "19:00"), accountId: bankA, toAccountId: bankB });
    expect(hits).toHaveLength(0);

    const good = await prisma.item.findFirstOrThrow({ where: { type: "BARANG_JADI", active: true } });
    const { sale } = await createSale({ date: jakartaDateTime("2032-05-15", "12:00"), storeId, newCustomerName: "Pembeli Uji Dobel", lines: [{ itemId: good.id, qty: 1, price: 90_000 }], paidNow: 40_000, bankAccountId: bankA, dueDate: jakartaDateTime("2032-05-30", "12:00") }, owner);
    expect(await prisma.financeTransaction.count({ where: { origin: "PENJUALAN", journalId: sale.journalId!, direction: "MASUK" } })).toBe(1);
    await paySale(sale.id, { amount: 50_000, bankAccountId: bankA, date: jakartaDateTime("2032-05-16", "12:00") }, owner);
    expect(await prisma.financeTransaction.count({ where: { origin: "PENJUALAN", originRef: sale.number, status: "DIBUKUKAN" } })).toBe(2);
    for (const p of await prisma.salePayment.findMany({ where: { saleId: sale.id, initial: false } })) await cancelSalePayment(p.id, "uji", owner);
    await cancelSale(sale.id, "uji", owner);
    expect(await prisma.financeTransaction.count({ where: { origin: "PENJUALAN", originRef: sale.number, status: "DIBUKUKAN" } })).toBe(0);
  });
});

describe("Nomor transaksi", () => {
  it("nomor TRX yang sudah dipakai di luar penghitung (skrip koreksi) dilewati, tidak gagal simpan", async () => {
    const d = jakartaDateTime("2032-06-03", "10:00");
    const a = await createTransaction({ direction: "KELUAR", amount: rnd(11_000), date: d, accountId: bankA, note: "nomor a" }, "MANUAL", owner);
    const next = a.transaction.number.replace(/\d{4}$/, (x) => String(Number(x) + 1).padStart(4, "0"));
    const b = await createTransaction({ direction: "KELUAR", amount: rnd(12_000), date: d, accountId: bankA, note: "nomor b" }, "MANUAL", owner);
    await prisma.financeTransaction.update({ where: { id: b.transaction.id }, data: { number: next.replace(/\d{4}$/, (x) => String(Number(x) + 1).padStart(4, "0")) } });
    // Penghitung berikutnya = nomor yang sudah dipakai b → dilewati
    const c = await createTransaction({ direction: "KELUAR", amount: rnd(13_000), date: d, accountId: bankA, note: "nomor c" }, "MANUAL", owner);
    expect(new Set([a.transaction.number, (await prisma.financeTransaction.findUniqueOrThrow({ where: { id: b.transaction.id } })).number, c.transaction.number]).size).toBe(3);
  });
});

describe("Sisihan otomatis diserap transfer aslinya", () => {
  it("baris 'Sisihan otomatis' otomatis Dibatalkan saat transfer berbukti untuk tanggal itu dibukukan; saldo tidak dobel", async () => {
    const e = await postReserve(fundId, "2032-05-24", owner);
    const auto = await prisma.financeTransaction.findFirstOrThrow({ where: { journalId: e.journalId! } });
    const before = await bal(bankB);
    const r = await bookReserveTransfer({ direction: "TRANSFER", amount: Number(e.amount), date: jakartaDateTime("2032-05-24", "20:00"), accountId: bankA, note: "nabung uji" }, [{ fundId, date: "2032-05-24", amount: Number(e.amount) }], "MANUAL", owner);
    expect(r.booked).toBe(true);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: auto.id } })).status).toBe("DIBATALKAN");
    expect(await bal(bankB)).toBe(before);
    expect(await prisma.financeTransaction.count({ where: { status: "DIBUKUKAN", toAccountId: bankB, date: { gte: jakartaDateTime("2032-05-24", "00:00"), lt: jakartaDateTime("2032-05-25", "00:00") } } })).toBe(1);
  });
});

describe("Cek transaksi mirip", () => {
  it("per jenis: pengeluaran, pemasukan, transfer; beda hari tanpa kemiripan bukan duplikat", async () => {
    const amt = rnd(123_000);
    const d = jakartaDateTime("2032-05-21", "09:00");
    const k = await createTransaction({ direction: "KELUAR", amount: amt, date: d, accountId: seabank, note: "servis kompresor" }, "MANUAL", owner);
    const m = await createTransaction({ direction: "MASUK", amount: amt, date: d, accountId: seabank, note: "terima dp pesanan" }, "MANUAL", owner);
    const t = await createTransaction({ direction: "TRANSFER", amount: amt, date: d, accountId: seabank, toAccountId: shopeepay }, "MANUAL", owner);
    expect((await findSimilar(prisma, { direction: "KELUAR", amount: amt, date: jakartaDateTime("2032-05-21", "15:00"), accountId: seabank }))[0]?.id).toBe(k.transaction.id);
    expect((await findSimilar(prisma, { direction: "MASUK", amount: amt, date: d }))[0]?.id).toBe(m.transaction.id);
    expect((await findSimilar(prisma, { direction: "TRANSFER", amount: amt, date: d, accountId: seabank, toAccountId: shopeepay }))[0]?.id).toBe(t.transaction.id);
    expect(await findSimilar(prisma, { direction: "TRANSFER", amount: amt, date: d, accountId: shopeepay, toAccountId: seabank })).toHaveLength(0);
    expect(await findSimilar(prisma, { direction: "KELUAR", amount: amt, date: jakartaDateTime("2032-05-22", "09:00"), accountId: seabank, text: "beli pulsa" })).toHaveLength(0);
    // Hari berikutnya tapi keterangan mirip → tetap ditanyakan
    expect(await findSimilar(prisma, { direction: "KELUAR", amount: amt, date: jakartaDateTime("2032-05-22", "09:00"), accountId: seabank, text: "servis kompresor angin" })).toHaveLength(1);
    // Sudah dinyatakan berbeda → tidak ditanyakan lagi
    expect(await findSimilar(prisma, { direction: "KELUAR", amount: amt, date: d, accountId: seabank, excludeIds: [k.transaction.id] })).toHaveLength(0);
  });

  it("bot pembelian: dobel ditanyakan; 'sama' tidak menyimpan, 'berbeda' lanjut dari langkah terakhir", async () => {
    const amt = rnd(210_000);
    const msg = `beli kardus uji dobel 50 pcs ${amt} dari seabank`;
    await say(msg);
    expect((await session())?.flow).toBe("beli");
    await tap("f:ok");
    const count = await prisma.purchase.count();

    await say(msg);
    await tap("f:ok");
    expect(sent.at(-1)!.text).toContain("Mirip transaksi yang sudah ada");
    expect(btns()).toEqual(expect.arrayContaining(["f:dupok", "f:dupno", "f:dupv"]));
    // Isian tidak hilang: tersimpan di langkah konfirmasi duplikat
    const s = await session();
    expect(s).toMatchObject({ flow: "beli", step: "dup" });
    expect((s!.data as Record<string, unknown>).dupStep).toBe("confirm");
    await tap("f:dupv");
    expect(sent.at(-1)!.text).toContain("/finance/");
    await tap("f:dupno");
    expect(await prisma.purchase.count()).toBe(count);
    expect(await session()).toBeNull();

    await say(msg);
    await tap("f:ok");
    expect((await session())?.step).toBe("dup");
    await tap("f:dupok");
    expect(await prisma.purchase.count()).toBe(count + 1);
    expect(sent.at(-1)!.text).toContain("tercatat");
    expect(await session()).toBeNull();
  });

  it("isian terhenti lama tidak hilang: tombol lama menawarkan Lanjutkan", async () => {
    await say(`beli kardus uji dobel 5 pcs ${rnd(31_000)} dari seabank`);
    await prisma.$executeRaw`UPDATE "BotSession" SET "updatedAt" = now() - interval '45 minutes' WHERE "chatId" = ${String(TG)}`;
    await tap("f:ok");
    expect(sent.at(-1)!.text).toContain("terhenti");
    expect(btns()).toEqual(expect.arrayContaining(["f:resume", "f:x"]));
    await tap("f:resume");
    expect(sent.at(-1)!.text).toContain("Pembelian");
    expect((await session())?.step).toBe("confirm");
  });

  it("kartu draft: pembuat bisa menyatakan berbeda; sisihan/talangan yang belum dibukukan tidak buntu", async () => {
    const amt = rnd(77_000);
    const first = await createTransaction({ direction: "KELUAR", amount: amt, date: new Date(), accountId: seabank, note: "beli galon" }, "MANUAL", owner);
    const second = await createTransaction({ direction: "KELUAR", amount: amt, date: new Date(), accountId: seabank, note: "beli galon" }, "TELEGRAM", owner);
    expect(second.transaction.duplicateOfId).toBe(first.transaction.id);
    await tap(`rev:${second.transaction.id}`);
    const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: second.transaction.id } });
    expect(t.duplicateOfId).toBeNull();
    expect(t.dupAckIds).toContain(first.transaction.id);
  });
});

describe("Saran kategori (tanpa AI) & kategori baru", () => {
  it("kata kunci, riwayat pihak, lalu usulan kategori baru", async () => {
    const listrik = await prisma.txCategory.findFirstOrThrow({ where: { name: "Listrik, Air & Gas" } });
    expect((await suggestCategories(prisma, { direction: "KELUAR", text: "bayar token pln" })).picks[0]).toMatchObject({ id: listrik.id, why: "kata kunci" });

    const packing = await prisma.txCategory.findFirstOrThrow({ where: { name: "Packing & Operasional" } });
    await prisma.financeTransaction.create({ data: { number: `UJI-${Date.now()}`, source: "MANUAL", direction: "KELUAR", amount: BigInt(10_000), date: new Date(), status: "DIBUKUKAN", fingerprint: "x", createdBy: "uji", categoryId: packing.id, counterparty: "Toko Sinarjaya Abadi" } });
    const h = await suggestCategories(prisma, { direction: "KELUAR", text: "transfer ke Sinarjaya Abadi" });
    expect(h.picks.map((p) => p.id)).toContain(packing.id);
    expect(h.picks.find((p) => p.id === packing.id)?.why).toBe("riwayat");

    const none = await suggestCategories(prisma, { direction: "KELUAR", text: "bayar sumbangan pengajian masjid 75rb dari seabank" });
    expect(none.picks).toHaveLength(0);
    expect(none.proposal).toMatchObject({ name: "Sumbangan Pengajian Masjid", direction: "KELUAR", coaType: "BEBAN" });
    expect(none.proposal!.parentLabel).toContain("6-9000");
  });

  it("kategori baru hanya dibuat setelah Owner/Finance setuju; kode akun otomatis", async () => {
    const name = `Uji Kategori ${Math.random().toString(36).slice(2, 6)}`;
    const parent = await prisma.coaAccount.findUniqueOrThrow({ where: { code: "6-9000" } });
    const prop = await proposeCategory({ name, direction: "KELUAR", coaType: "BEBAN", parentCoaId: parent.id, parentLabel: null, keywords: name.toLowerCase() }, {}, owner);
    expect(await prisma.txCategory.count({ where: { name } })).toBe(0);
    const admin = await prisma.user.findUniqueOrThrow({ where: { username: "admin" } });
    await expect(approveCategoryProposal(prop.id, { id: admin.id, name: admin.name, role: admin.role })).rejects.toThrow(/Owner\/Finance/);
    await expect(rejectCategoryProposal(prop.id, { id: admin.id, name: admin.name, role: admin.role })).rejects.toThrow(/Owner\/Finance/);
    expect(await prisma.txCategory.count({ where: { name } })).toBe(0);
    const fin = await prisma.user.findUniqueOrThrow({ where: { username: "finance" } });
    const r = await approveCategoryProposal(prop.id, { id: fin.id, name: fin.name, role: fin.role });
    createdCats.push(r.categoryId);
    const cat = await prisma.txCategory.findUniqueOrThrow({ where: { id: r.categoryId }, include: { coaAccount: { include: { parent: true } } } });
    expect(cat.coaAccount.code).toMatch(/^6-\d{4}$/);
    expect(cat.coaAccount.name).toBe(`Beban ${name}`);
    expect(cat.coaAccount.parent?.code).toBe("6-9000");
    await expect(approveCategoryProposal(prop.id, { id: fin.id, name: fin.name, role: fin.role })).rejects.toThrow(/sudah/);
  });

  it("bot: draft tanpa kategori menampilkan usulan; Owner menyetujui → draft memakai kategori baru", async () => {
    const uniq = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 6);
    await say(`bayar sumbangan ${uniq} pengajian ${rnd(41_000)} dari seabank`);
    const t = await prisma.financeTransaction.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(t.categoryId).toBeNull();
    const sug = (t.aiExtraction as { catSuggest?: { proposal?: { name: string } } }).catSuggest;
    expect(sug?.proposal?.name.toLowerCase()).toBe(`sumbangan ${uniq} pengajian`);
    expect(btns()).toContain(`kn:${t.id}`);
    await tap(`kn:${t.id}`);
    const prop = await prisma.categoryProposal.findFirstOrThrow({ where: { transactionId: t.id } });
    expect(btns()).toContain(`ka:${prop.id}`);
    expect(btns().every((c) => Buffer.byteLength(c) <= 64)).toBe(true);
    await tap(`ka:${prop.id}`);
    const u = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(u.categoryId).toBeTruthy();
    createdCats.push(u.categoryId!);
    expect((await prisma.txCategory.findUniqueOrThrow({ where: { id: u.categoryId! } })).name).toBe(prop.name);
  });
});
