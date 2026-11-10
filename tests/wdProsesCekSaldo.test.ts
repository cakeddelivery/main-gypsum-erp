import { beforeAll, describe, expect, it, vi } from "vitest";

type Btn = { text: string; callback_data: string };
const sent: { chat: string; text: string; buttons?: Btn[][] }[] = [];
vi.mock("@/lib/telegram", async (orig) => {
  const real = await orig<typeof import("@/lib/telegram")>();
  return {
    ...real,
    telegramConfigured: () => true,
    sendTelegram: vi.fn(async (chat: string, text: string, o: { buttons?: Btn[][] } = {}) => (sent.push({ chat, text, buttons: o.buttons }), { ok: true })),
    editTelegram: vi.fn(async (chat: string, _m: number, text: string, buttons?: Btn[][]) => (sent.push({ chat, text, buttons }), { ok: true })),
    answerCallback: vi.fn(async () => ({ ok: true })),
    chatAction: vi.fn(async () => ({ ok: true })),
    // Lampiran mutasi: PDF kecil yang valid (magic bytes %PDF)
    // Lampiran: file id "img…" = foto JPEG, lainnya PDF (magic bytes valid)
    downloadTelegramFile: vi.fn(async (id: string) => (id.startsWith("img") ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) : Buffer.from("%PDF-1.4 mutasi uji"))),
  };
});
// OCR server: teks bukti diatur per tes
const ocr = { text: "" };
vi.mock("@/lib/ocrReceipt", async (orig) => ({ ...(await orig<typeof import("@/lib/ocrReceipt")>()), ocrImageText: vi.fn(async () => ocr.text) }));

import { prisma } from "@/lib/db";
import { handleTelegramUpdate } from "@/lib/bot";
import { bankBalances, cancelBookedTransaction, changeBookedStore, createTransaction, FinanceError, rejectTransaction, transitAccount } from "@/lib/finance";
import { balanceSheet, profitLoss } from "@/lib/accounting";
import { activeDuplicateJournals } from "@/lib/auditChecks";
import { addDays, jakartaDateTime, todayStr } from "@/lib/time";
import { confirmTransaction, inProcessSummary, inProcessWithdrawals, isTiktokSeller, receiveWithdraw } from "@/lib/wdProcess";
import { sendWdProcessReminder } from "@/lib/jobs";
import { readWdProofText } from "@/lib/wdProof";
import { balanceCheckRecipients, checkMessage, parseBalance, prepareChecks, RECIPIENT_SETTING, sendBalanceCheck, sendBalanceCheckReminder } from "@/lib/balanceCheck";

// Data tes terisolasi: rekening sendiri (bukan 0006/5984), nominal unik
const TG = 777_091;
const JOJO_TG = 777_092;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = (Math.floor(Date.now() / 1000) % 1_000_000_000) + 1_900_000;
const say = (text: string, f = from) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat: { id: f.id }, from: f, text } } as never);
const tap = (data: string, f = from) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from: f, data, message: { message_id: 1, chat: { id: f.id } } } } as never);
const btns = () => sent.at(-1)?.buttons?.flat() ?? [];
const uniq = (base: number) => base + (Date.now() % 997);
/** Bukti terbaca: nominal + tanggal (+ jam) seperti hasil OCR screenshot bank / Seller Center */
const pf = (amount: number, at: Date = new Date(Date.now() - 60_000)) => {
  const d = at.toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
  const t = at.toLocaleTimeString("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false });
  return { path: "uji/bukti.jpg", mime: "image/jpeg", read: { amounts: [amount], amount, date: d, time: t } };
};
const amtOf = async (id: string) => Number((await prisma.financeTransaction.findUniqueOrThrow({ where: { id } })).amount);
const proofText = (amount: number, d: string, hm: string) => `SeaBank\nUang Masuk\nRp${amount.toLocaleString("id-ID")}\nDari TIKTOK SHOP\n${d.split("-").reverse().join("/")} ${hm}`;
const photo = (id: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, photo: [{ file_id: id }] } } as never);

let owner: { id: string; name: string };
let tiktok: string;
let bankJ: string;
let mg: string;
const bal = async (id: string) => (await bankBalances()).find((b) => b.id === id)?.balance ?? 0;
let transitId: string;
const coaBal = async (accountId: string) => {
  const a = await prisma.journalLine.aggregate({ where: { accountId }, _sum: { debit: true, credit: true } });
  return Number(a._sum.debit ?? 0) - Number(a._sum.credit ?? 0);
};
const sales = async (d: string) => (await profitLoss({ start: jakartaDateTime(d, "00:00"), end: jakartaDateTime(d, "23:59") })).revenue.find((x) => x.code === "4-1000")?.amount ?? 0;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  owner = { id: u.id, name: u.name };
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG), canConfirm: true }, update: { active: true, canConfirm: true, chatId: String(TG) } });
  const c1 = await prisma.coaAccount.upsert({ where: { code: "1-1971" }, create: { code: "1-1971", name: "Saldo Penjual TikTok Uji J", type: "ASET", isCash: true }, update: {} });
  const c2 = await prisma.coaAccount.upsert({ where: { code: "1-1972" }, create: { code: "1-1972", name: "Bank Uji J", type: "ASET", isCash: true }, update: {} });
  tiktok = (await prisma.bankAccount.upsert({ where: { code: "SALDO_TIKTOK_J" }, create: { code: "SALDO_TIKTOK_J", name: "Saldo Penjual TikTok Uji J", coaAccountId: c1.id, marketplace: true, aliases: "dompetjj" }, update: {} })).id;
  bankJ = (await prisma.bankAccount.upsert({ where: { code: "BANK_UJI_J" }, create: { code: "BANK_UJI_J", name: "Bank Uji J", coaAccountId: c2.id, aliases: "rekjj" }, update: {} })).id;
  mg = (await prisma.store.findUniqueOrThrow({ where: { code: "MG" } })).id;
  transitId = (await transitAccount(prisma)).id;
});

const newWd = async (amount: number, date = jakartaDateTime(addDays(todayStr(), -1), "20:15")) =>
  (await createTransaction({ direction: "TRANSFER", amount, date, accountId: tiktok, toAccountId: bankJ, storeId: mg, note: "WD tiktok uji J" }, "MANUAL", owner, { submit: true })).transaction;

describe("WD TikTok Dalam Proses", () => {
  it("mengenali saldo penjual TikTok, bukan Shopee", () => {
    expect(isTiktokSeller({ name: "Saldo Penjual TikTok", marketplace: true })).toBe(true);
    expect(isTiktokSeller({ name: "Saldo Penjual Shopee", marketplace: true })).toBe(false);
    expect(isTiktokSeller({ name: "TikTok", marketplace: false })).toBe(false);
  });

  it("konfirmasi → Dalam Proses + jurnal 1 (penjualan diakui tgl transfer, Dana dalam Perjalanan), saldo bank tetap; Uang diterima → jurnal 2 SEKALI", async () => {
    const amt = uniq(512_000);
    const sentDay = addDays(todayStr(), -1);
    const t = await newWd(amt, jakartaDateTime(sentDay, "20:15"));
    const [b0, tr0, s0] = [await bal(bankJ), await coaBal(transitId), await sales(sentDay)];
    const r = await confirmTransaction(t.id, owner);
    expect(r.inProcess).toBe(true);
    const p = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(p.status).toBe("DALAM_PROSES");
    expect(p.journalId).toBe(r.journal!.id);
    expect(p.sentAt?.getTime()).toBe(t.date.getTime());
    expect(r.journal!.date.getTime()).toBe(t.date.getTime());
    expect(await bal(bankJ)).toBe(b0);
    expect(await coaBal(transitId)).toBe(tr0 + amt);
    expect(await sales(sentDay)).toBe(s0 + amt);
    expect(await bal(tiktok)).toBe(0);
    // Tidak bisa dibukukan / ditolak lewat jalur biasa selama Dalam Proses
    await expect(confirmTransaction(t.id, owner)).rejects.toThrow(/Dalam Proses/);
    await expect(rejectTransaction(t.id, owner, "x")).rejects.toThrow(/Batalkan/);

    const got = jakartaDateTime(todayStr(), "08:18");
    const { journal } = await receiveWithdraw(t.id, owner, { canApprove: true, proof: pf(amt, got) }, new Date(got.getTime() + 60_000));
    const done = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(done).toMatchObject({ status: "DIBUKUKAN", journalId: r.journal!.id });
    expect(done.date.getTime()).toBe(t.date.getTime());
    expect(done.receivedAt?.getTime()).toBe(got.getTime());
    expect(journal).toMatchObject({ source: "WD_DITERIMA", sourceId: t.id });
    expect(journal.date.getTime()).toBe(got.getTime());
    expect(await bal(bankJ)).toBe(b0 + amt);
    expect(await coaBal(transitId)).toBe(tr0);
    expect(await sales(sentDay)).toBe(s0 + amt); // tidak dobel
    expect(await bal(tiktok)).toBe(0);
    // Sekali saja
    await expect(receiveWithdraw(t.id, owner, { canApprove: true, proof: pf(amt, got) })).rejects.toThrow(/sudah dibukukan/);
    expect(await prisma.journal.count({ where: { sourceId: t.id, source: "FINANCE" } })).toBe(1);
    expect(await prisma.journal.count({ where: { sourceId: t.id, source: "WD_DITERIMA" } })).toBe(1);
    // Pemeriksaan jurnal ganda (audit:saldo) tidak salah menandai
    expect((await activeDuplicateJournals(prisma, jakartaDateTime(addDays(todayStr(), -3), "00:00"))).filter((g) => g.sourceId === t.id)).toEqual([]);
    // Neraca seimbang
    expect((await balanceSheet(new Date(Date.now() + 86_400_000))).balanced).toBe(true);
  });

  it("Dana dalam Perjalanan tampil di Neraca selama ada WD dalam proses", async () => {
    const t = await newWd(uniq(201_000));
    await confirmTransaction(t.id, owner);
    const bs = await balanceSheet(new Date(Date.now() + 86_400_000));
    const acc = await prisma.coaAccount.findUniqueOrThrow({ where: { id: transitId } });
    expect(acc).toMatchObject({ name: "Dana dalam Perjalanan", type: "ASET", isCash: true });
    expect(bs.assets.find((x) => x.code === acc.code)?.amount).toBe(await coaBal(transitId));
    expect(bs.balanced).toBe(true);
    await receiveWithdraw(t.id, owner, { canApprove: true, proof: pf(await amtOf(t.id)) });
  });

  it("batal saat Dalam Proses membalik jurnal 1; batal setelah diterima membalik jurnal 1 & 2", async () => {
    const day = addDays(todayStr(), -1);
    const amt = uniq(377_000);
    const [b0, tr0, s0] = [await bal(bankJ), await coaBal(transitId), await sales(day)];
    const t = await newWd(amt, jakartaDateTime(day, "19:00"));
    await confirmTransaction(t.id, owner);
    await expect(receiveWithdraw(t.id, owner, { canApprove: true, proof: pf(amt, new Date(Date.now() + 86_400_000)) })).rejects.toThrow(FinanceError);
    const other = await prisma.user.findFirstOrThrow({ where: { role: { not: "OWNER" }, active: true } });
    await expect(receiveWithdraw(t.id, { id: other.id, name: other.name }, { canApprove: false, proof: pf(amt) })).rejects.toThrow(/pembuat/);
    await cancelBookedTransaction(t.id, owner, "uang tidak masuk");
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DIBATALKAN");
    expect([await bal(bankJ), await coaBal(transitId), await sales(day)]).toEqual([b0, tr0, s0]);

    const u = await newWd(amt + 1, jakartaDateTime(day, "19:05"));
    await confirmTransaction(u.id, owner);
    await receiveWithdraw(u.id, owner, { canApprove: true, proof: pf(await amtOf(u.id)) });
    expect(await bal(bankJ)).toBe(b0 + amt + 1);
    await cancelBookedTransaction(u.id, owner, "salah catat");
    expect([await bal(bankJ), await coaBal(transitId), await sales(day), await bal(tiktok)]).toEqual([b0, tr0, s0, 0]);
    expect((await activeDuplicateJournals(prisma, jakartaDateTime(addDays(todayStr(), -3), "00:00"))).filter((g) => g.sourceId === u.id)).toEqual([]);
  });

  it("ganti toko (Dalam Proses & sesudah diterima) memindah penjualan antar toko; saldo tetap", async () => {
    const dl = (await prisma.store.findUniqueOrThrow({ where: { code: "DL" } })).id;
    const day = addDays(todayStr(), -1);
    const amt = uniq(155_000);
    const t = await newWd(amt, jakartaDateTime(day, "18:00"));
    await confirmTransaction(t.id, owner);
    const salesOf = async (store: string) => (await profitLoss({ start: jakartaDateTime(day, "00:00"), end: jakartaDateTime(day, "23:59"), storeId: store })).revenue.find((x) => x.code === "4-1000")?.amount ?? 0;
    const [mg0, dl0, tr0] = [await salesOf(mg), await salesOf(dl), await coaBal(transitId)];
    await changeBookedStore(t.id, dl, owner);
    expect([await salesOf(mg), await salesOf(dl), await coaBal(transitId)]).toEqual([mg0 - amt, dl0 + amt, tr0]);
    const b0 = await bal(bankJ);
    await receiveWithdraw(t.id, owner, { canApprove: true, proof: pf(await amtOf(t.id)) });
    await changeBookedStore(t.id, mg, owner);
    expect([await salesOf(mg), await salesOf(dl), await bal(bankJ), await coaBal(transitId) ]).toEqual([mg0, dl0, b0 + amt, tr0 - amt]);
    expect((await activeDuplicateJournals(prisma, jakartaDateTime(addDays(todayStr(), -3), "00:00"))).filter((g) => g.sourceId === t.id)).toEqual([]);
    expect(await bal(tiktok)).toBe(0);
  });

  it("transaksi selain WD TikTok tetap langsung dibukukan", async () => {
    const shopee = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SALDO_SHOPEE" } })).id;
    const { transaction } = await createTransaction({ direction: "TRANSFER", amount: uniq(233_000), date: new Date(), accountId: shopee, toAccountId: bankJ, storeId: mg }, "MANUAL", owner, { submit: true });
    const r = await confirmTransaction(transaction.id, owner);
    expect(r.inProcess).toBe(false);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: transaction.id } })).status).toBe("DIBUKUKAN");
  });

  it("data tab & popup: daftar Dalam Proses + ringkasan jumlah/total; baris hilang setelah diterima", async () => {
    const a = await newWd(uniq(141_000));
    const b = await newWd(uniq(142_000));
    await confirmTransaction(a.id, owner);
    await confirmTransaction(b.id, owner);
    let rows = await inProcessWithdrawals();
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    const s = inProcessSummary(rows);
    expect(s.count).toBe(await prisma.financeTransaction.count({ where: { status: "DALAM_PROSES", deletedAt: null } }));
    expect(s.total).toBe(rows.reduce((t, r) => t + r.amount, 0));
    expect(rows.find((r) => r.id === a.id)).toMatchObject({ to: "Bank Uji J", store: "MG", createdById: owner.id });
    await receiveWithdraw(a.id, owner, { canApprove: true, proof: pf(await amtOf(a.id)) });
    rows = await inProcessWithdrawals();
    expect(rows.some((r) => r.id === a.id)).toBe(false);
    expect(rows.some((r) => r.id === b.id)).toBe(true);
    await receiveWithdraw(b.id, owner, { canApprove: true, proof: pf(await amtOf(b.id)) });
  });

  it("bot: kartu WD TikTok → Konfirmasi (dalam proses) → tombol Uang diterima → pilih Kemarin → dibukukan", async () => {
    const amt = uniq(463_000);
    sent.length = 0;
    await say(`WD dari dompetjj MG ${amt} ke rekjj`);
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { telegramChatId: String(TG) }, orderBy: { createdAt: "desc" } });
    expect(t).toMatchObject({ direction: "TRANSFER", accountId: tiktok, toAccountId: bankJ });
    expect(sent.at(-1)?.text).toContain("1–3 hari");
    expect(btns().some((x) => x.callback_data === `ok:${t.id}` && x.text.includes("uang belum masuk"))).toBe(true);
    expect(btns().some((x) => x.callback_data === `wr:${t.id}`)).toBe(true);
    const b0 = await bal(bankJ);
    await tap(`ok:${t.id}`);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DALAM_PROSES");
    expect(sent.at(-1)?.text).toContain("Dalam proses");
    expect(btns().map((x) => x.callback_data)).toEqual([`wr:${t.id}`]);
    expect(await bal(bankJ)).toBe(b0);
    // Uang diterima: wajib screenshot bukti; tanggal & jam diambil dari bukti
    await tap(`wr:${t.id}`);
    expect(sent.at(-1)?.text).toContain("screenshot bukti");
    const kemarin = addDays(todayStr(), -1);
    // Bukti salah nominal → ditolak, belum dibukukan
    ocr.text = proofText(amt + 5000, kemarin, "08:18");
    await photo("img-salah");
    expect(sent.at(-1)?.text).toContain("Bukti belum valid");
    expect(btns().map((x) => x.callback_data)).toEqual([`wp:${t.id}`]);
    await tap(`wd:${t.id}:ok`);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DALAM_PROSES");
    // Bukti benar → tombol Simpan dengan tanggal/jam dari bukti
    ocr.text = proofText(amt, kemarin, "08:18");
    await photo("img-benar");
    expect(sent.at(-1)?.text).toContain("Bukti valid");
    const save = btns().find((x) => x.callback_data === `wd:${t.id}:ok`);
    expect(save?.text).toContain("08:18");
    expect(btns().every((x) => Buffer.byteLength(x.callback_data) <= 64)).toBe(true);
    await tap(save!.callback_data);
    const done = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(done.status).toBe("DIBUKUKAN");
    expect(done.receivedAt?.getTime()).toBe(jakartaDateTime(kemarin, "08:18").getTime());
    expect(done.receivedProofPath).toBeTruthy();
    expect(done.receivedProofRead).toMatchObject({ amount: amt, date: kemarin, time: "08:18", manual: false });
    expect(await bal(bankJ)).toBe(b0 + amt);
    // Tekan lagi: tidak dobel
    await tap(save!.callback_data);
    expect(await bal(bankJ)).toBe(b0 + amt);
  });

  it("bot: bukti tidak terbaca → Owner bisa simpan dengan cek manual (tercatat); tanpa bukti tidak bisa", async () => {
    const amt = uniq(388_000);
    await say(`WD dari dompetjj MG ${amt} ke rekjj`);
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { telegramChatId: String(TG) }, orderBy: { createdAt: "desc" } });
    // Tanpa bukti: tombol simpan ditolak
    await tap(`wd:${t.id}:${todayStr().replace(/-/g, "")}`);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("MENUNGGU_KONFIRMASI");
    await tap(`wr:${t.id}`);
    ocr.text = "foto buram tanpa angka";
    await photo("img-buram");
    expect(sent.at(-1)?.text).toContain("Bukti belum valid");
    await tap(`wp:${t.id}`);
    expect(btns().length).toBeGreaterThanOrEqual(7);
    await tap(`wd:${t.id}:${todayStr().replace(/-/g, "")}`);
    const done = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(done.status).toBe("DIBUKUKAN");
    expect(done.receivedProofRead).toMatchObject({ manual: true });
    expect((await prisma.approvalLog.findFirstOrThrow({ where: { transactionId: t.id, action: "UANG_DITERIMA" } })).note).toContain("dicek manual");
  });

  it("bukti Seller Center: catatan 1–3 hari, tanggal terima dipilih (tidak sebelum ditransfer)", async () => {
    const amt = uniq(611_000);
    const t = await newWd(amt);
    await confirmTransaction(t.id, owner);
    const kemarin = addDays(todayStr(), -1);
    const seller = { path: "uji/s.jpg", mime: "image/jpeg", read: { ...readWdProofText(`Riwayat penarikan\nDitransfer ke bank\n${kemarin.split("-").reverse().join("/")} 20:15\nJumlah Rp ${amt.toLocaleString("id-ID")}`), } };
    expect(seller.read.source).toBe("seller");
    await expect(receiveWithdraw(t.id, owner, { canApprove: true, proof: seller, receivedAt: jakartaDateTime(kemarin, "10:00") })).rejects.toThrow(/sebelum ditransfer/);
    const got = jakartaDateTime(todayStr(), "00:30");
    const r = await receiveWithdraw(t.id, owner, { canApprove: true, proof: seller, receivedAt: got }, new Date(got.getTime() + 60_000));
    expect(r.transaction.receivedAt?.getTime()).toBe(got.getTime());

    // Bot: tombol tanggal mulai tanggal transfer, catatan 1–3 hari
    const u = await newWd(amt + 3);
    await confirmTransaction(u.id, owner);
    await tap(`wr:${u.id}`);
    ocr.text = `Seller Center\nDitransfer ke bank\n${kemarin.split("-").reverse().join("/")} 20:15\nRp${(amt + 3).toLocaleString("id-ID")}`;
    await photo("img-seller");
    expect(sent.at(-1)?.text).toContain("1–3 hari");
    const datas = btns().map((x) => x.callback_data);
    expect(datas).toContain(`wd:${u.id}:ok`);
    expect(datas).toContain(`wd:${u.id}:${todayStr().replace(/-/g, "")}`);
    expect(datas).not.toContain(`wd:${u.id}:${addDays(todayStr(), -2).replace(/-/g, "")}`);
    await tap(`wd:${u.id}:${todayStr().replace(/-/g, "")}`);
    const done = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: u.id } });
    expect(done.status).toBe("DIBUKUKAN");
    expect(done.receivedProofRead).toMatchObject({ source: "seller", manual: false });
    expect(done.receivedAt?.toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" })).toBe(todayStr());
  });

  it("validasi bukti: wajib ada; nominal harus cocok; tanggal/jam dari bukti; bukan penyetuju tidak boleh cek manual", async () => {
    const amt = uniq(222_000);
    const t = await newWd(amt);
    await confirmTransaction(t.id, owner);
    await expect(receiveWithdraw(t.id, owner, { canApprove: true, proof: null })).rejects.toThrow(/Wajib lampirkan/);
    await expect(receiveWithdraw(t.id, owner, { canApprove: true, proof: pf(amt + 1) })).rejects.toThrow(/Bukti belum valid/);
    const blank = { path: "uji/b.jpg", mime: "image/jpeg", read: null };
    await expect(receiveWithdraw(t.id, owner, { canApprove: false, proof: blank, manual: true, receivedAt: new Date() })).rejects.toThrow(/Owner\/Finance/);
    const at = jakartaDateTime(todayStr(), "06:05");
    const r = await receiveWithdraw(t.id, owner, { canApprove: true, proof: pf(amt, at), receivedAt: new Date() }, new Date(at.getTime() + 60_000));
    expect(r.transaction.receivedAt?.getTime()).toBe(at.getTime());
  });

  it("pengingat harian WD: hanya dikirim bila ada; tombol per WD; pesan diperbarui setelah diterima", async () => {
    // Bersihkan WD dalam proses dari tes lain (ditolak, tanpa jurnal)
    for (const r of await inProcessWithdrawals()) await cancelBookedTransaction(r.id, owner, "bersih tes");
    sent.length = 0;
    expect(await sendWdProcessReminder()).toMatchObject({ sent: 0, skipped: expect.any(String) });
    expect(sent.length).toBe(0);
    const t = await newWd(uniq(299_000));
    await confirmTransaction(t.id, owner);
    const r = await sendWdProcessReminder();
    expect(r.sent).toBeGreaterThan(0);
    const msg = sent.find((x) => x.chat === String(TG))!;
    expect(msg.text).toContain("1 withdraw TikTok dalam proses");
    expect(msg.buttons?.flat().map((x) => x.callback_data)).toEqual([`wr:${t.id}:r`]);
    await tap(`wr:${t.id}:r`);
    ocr.text = proofText(await amtOf(t.id), todayStr(), "00:01");
    await photo("img-ingat");
    expect(btns().map((x) => x.callback_data)).toEqual([`wd:${t.id}:ok:r`]);
    await tap(`wd:${t.id}:ok:r`);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DIBUKUKAN");
    expect(sent.at(-1)?.text).toContain("Semua withdraw TikTok sudah diterima");
  });
});

describe("Cek saldo pagi", () => {
  // Tanggal unik jauh di depan agar baris cek tidak bentrok dengan data lain
  const now = jakartaDateTime("2031-03-16", "05:01");
  const date = "2031-03-15";
  let jojo: { id: string; name: string };

  beforeAll(async () => {
    const pw = (await prisma.user.findUniqueOrThrow({ where: { username: "owner" } })).passwordHash;
    const u = await prisma.user.upsert({ where: { username: "jojo_uji_j" }, create: { username: "jojo_uji_j", name: "Jojo Uji", passwordHash: pw, role: "ADMIN" }, update: { active: true } });
    jojo = { id: u.id, name: u.name };
    await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(JOJO_TG) }, create: { telegramUserId: String(JOJO_TG), userId: u.id, chatId: String(JOJO_TG), canSubmit: false }, update: { active: true, chatId: String(JOJO_TG) } });
    await prisma.setting.upsert({ where: { key: RECIPIENT_SETTING }, create: { key: RECIPIENT_SETTING, value: "jojo_uji_j" }, update: { value: "jojo_uji_j" } });
  });

  it("penerima dari setting; parse saldo yang diketik", async () => {
    expect((await balanceCheckRecipients()).map((r) => r.userId)).toEqual([jojo.id]);
    expect(parseBalance("1.234.567")).toBe(1_234_567);
    expect(parseBalance("Rp 1,234,567")).toBe(1_234_567);
    expect(parseBalance("1.234.567,00")).toBe(1_234_567);
    expect(parseBalance("948654")).toBe(948_654);
    expect(parseBalance("abc")).toBeNull();
  });

  it("05.00: saldo per rekening bukan saldo penjual (kemarin 23.59 + saat ini), tombol Sesuai/Tidak/Semua; aman diulang", async () => {
    sent.length = 0;
    const r = await sendBalanceCheck(now);
    expect(r.sent).toBe(1);
    const rows = await prisma.balanceCheck.findMany({ where: { date: new Date(`${date}T00:00:00Z`) }, include: { bankAccount: true } });
    expect(rows.some((x) => x.bankAccountId === bankJ)).toBe(true);
    expect(rows.some((x) => x.bankAccount.marketplace)).toBe(false);
    expect(rows.find((x) => x.bankAccountId === bankJ)!.bookBalance).toBe(BigInt(await bal(bankJ)));
    const m = sent.find((x) => x.chat === String(JOJO_TG))!;
    expect(m.text).toContain("23.59");
    const data = m.buttons!.flat().map((x) => x.callback_data);
    expect(data).toContain(`cs:all:20310315`);
    expect(data.every((d) => Buffer.byteLength(d) <= 64)).toBe(true);
    await prepareChecks(date);
    expect(await prisma.balanceCheck.count({ where: { date: new Date(`${date}T00:00:00Z`) } })).toBe(rows.length);
  });

  it("Sesuai / Tidak sesuai (ketik saldo + lampiran + Selesai) → Owner diberi tahu; pengingat 12.00 sekali", async () => {
    const jf = { id: JOJO_TG, first_name: "Jojo" };
    const rows = await prisma.balanceCheck.findMany({ where: { date: new Date(`${date}T00:00:00Z`) }, include: { bankAccount: true } });
    const target = rows.find((x) => x.bankAccountId === bankJ)!;
    const others = rows.filter((x) => x.id !== target.id);
    await tap(`cs:ok:${others[0].id}`, jf);
    expect((await prisma.balanceCheck.findUniqueOrThrow({ where: { id: others[0].id } })).status).toBe("SESUAI");

    sent.length = 0;
    await tap(`cs:no:${target.id}`, jf);
    expect(sent.at(-1)?.text).toContain("Ketik");
    const book = await bal(bankJ);
    await say(`${(book + 12_345).toLocaleString("id-ID")}`, jf);
    let c = await prisma.balanceCheck.findUniqueOrThrow({ where: { id: target.id } });
    expect(c).toMatchObject({ status: "TIDAK_SESUAI", bankBalance: BigInt(book + 12_345), diff: BigInt(12_345), done: false, checkedByName: "Jojo Uji" });
    const doc = (k: number) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat: { id: JOJO_TG }, from: jf, document: { file_id: `f${k}`, mime_type: "application/pdf", file_name: "mutasi.pdf" } } } as never);
    await doc(1);
    await doc(2);
    c = await prisma.balanceCheck.findUniqueOrThrow({ where: { id: target.id } });
    expect((c.attachments as unknown[]).length).toBe(2);

    // Pengingat 12.00 (sebelum selesai): ada yang belum dijawab → dikirim sekali
    sent.length = 0;
    const r1 = await sendBalanceCheckReminder(jakartaDateTime("2031-03-16", "12:00"));
    expect(r1.sent).toBe(1);
    expect(sent[0].text).toContain("Pengingat cek saldo");
    expect((await sendBalanceCheckReminder(jakartaDateTime("2031-03-16", "12:05"))).skipped).toBe("sudah diingatkan");

    sent.length = 0;
    await tap(`cs:done:${target.id}`, jf);
    c = await prisma.balanceCheck.findUniqueOrThrow({ where: { id: target.id } });
    expect(c.done).toBe(true);
    const toOwner = sent.find((x) => x.chat === String(TG));
    expect(toOwner?.text).toContain("Saldo tidak sesuai");
    expect(toOwner?.text).toContain("Bank Uji J");
    expect(toOwner?.text).toContain("12.345");
    expect(toOwner?.text).toContain("Lampiran mutasi: 2");
    expect(await prisma.botSession.findUnique({ where: { chatId: String(JOJO_TG) } })).toBeNull();

    // Sisanya: Semua sesuai → tidak ada pengingat lagi
    await tap(`cs:all:20310315`, jf);
    const left = await prisma.balanceCheck.count({ where: { date: new Date(`${date}T00:00:00Z`), status: "MENUNGGU" } });
    expect(left).toBe(0);
    const msg = checkMessage(date, await prisma.balanceCheck.findMany({ where: { date: new Date(`${date}T00:00:00Z`) }, include: { bankAccount: true } }));
    expect(msg.buttons).toEqual([]);
  });

  it("pengingat 12.00 tidak dikirim bila semua sudah dijawab", async () => {
    sent.length = 0;
    const r = await sendBalanceCheckReminder(jakartaDateTime("2031-03-16", "12:10"));
    expect(r.sent).toBe(0);
    expect(sent.length).toBe(0);
  });

  it("pengguna lain (bukan penerima, bukan Owner/Finance) tidak boleh menjawab", async () => {
    const d2 = "2031-03-20";
    await prepareChecks(d2);
    const row = await prisma.balanceCheck.findFirstOrThrow({ where: { date: new Date(`${d2}T00:00:00Z`) } });
    await prisma.setting.update({ where: { key: RECIPIENT_SETTING }, data: { value: "owner" } });
    await tap(`cs:ok:${row.id}`, { id: JOJO_TG, first_name: "Jojo" });
    expect((await prisma.balanceCheck.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("MENUNGGU");
    await prisma.setting.deleteMany({ where: { key: RECIPIENT_SETTING } });
  });
});
