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
    downloadTelegramFile: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9])),
  };
});
// OCR server: teks screenshot diatur per tes (AI tidak terpasang di tes)
const ocr = { text: "" };
vi.mock("@/lib/ocrReceipt", async (orig) => ({ ...(await orig<typeof import("@/lib/ocrReceipt")>()), ocrImageText: vi.fn(async () => ocr.text) }));

import { prisma } from "@/lib/db";
import { handleTelegramUpdate } from "@/lib/bot";
import { bankBalances, transitAccount } from "@/lib/finance";
import { findSimilar } from "@/lib/similar";
import { jakartaDateTime } from "@/lib/time";
import { parseSellerWithdrawal, readWdProofText } from "@/lib/wdProof";
import { WD_TIKTOK_BANK_SETTING } from "@/lib/wdProcess";

// Contoh dari user (10 Nov): screenshot "Detail penarikan dana" TikTok Seller Center
const SHOT = (o: { amount: number; ref: string; last4?: string; done: boolean }) =>
  [
    "Detail penarikan dana",
    "Jumlah penarikan dana",
    `Rp${o.amount.toLocaleString("id-ID")}`,
    "Rekening bank",
    `SeaBank ********${o.last4 ?? LAST4}`,
    "No. Referensi",
    o.ref,
    "Progres",
    ...(o.done ? ["Berhasil ditransfer", "10/11/2026 07:34"] : []),
    "Sedang diproses",
    "Pengajuan",
    "09/11/2026 20:58",
  ].join("\n");

// Data tes terisolasi: rekening sendiri (bukan 0006/5984), nominal & No. Referensi unik
const LAST4 = "7731";
const TG = 777_301;
const chat = { id: TG };
const from = { id: TG, first_name: "Owner" };
let n = (Math.floor(Date.now() / 1000) % 1_000_000_000) + 2_900_000;
const say = (text: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text } } as never);
const shot = (caption: string) => handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, caption, photo: [{ file_id: `img${n}` }] } } as never);
const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);
const btns = () => sent.at(-1)?.buttons?.flat() ?? [];
const uniq = (base: number) => base + (Date.now() % 997);
const refOf = (k: number) => `${String(Date.now()).slice(-9)}${k}0220 47837`;
const bal = async (id: string) => (await bankBalances()).find((b) => b.id === id)?.balance ?? 0;
const coaBal = async (accountId: string) => {
  const a = await prisma.journalLine.aggregate({ where: { accountId }, _sum: { debit: true, credit: true } });
  return Number(a._sum.debit ?? 0) - Number(a._sum.credit ?? 0);
};
const last = () => prisma.financeTransaction.findFirstOrThrow({ where: { telegramChatId: String(TG) }, orderBy: { createdAt: "desc" } });

let seller: string;
let dest: string;
let transit: string;

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG), canConfirm: true }, update: { active: true, canConfirm: true, chatId: String(TG) } });
  const c1 = await prisma.coaAccount.upsert({ where: { code: "1-1973" }, create: { code: "1-1973", name: "Saldo Penjual TikTok Uji K", type: "ASET", isCash: true }, update: {} });
  const c2 = await prisma.coaAccount.upsert({ where: { code: "1-1974" }, create: { code: "1-1974", name: "Seabank Uji K", type: "ASET", isCash: true }, update: {} });
  seller = (await prisma.bankAccount.upsert({ where: { code: "SALDO_TIKTOK_K" }, create: { code: "SALDO_TIKTOK_K", name: "Saldo Penjual TikTok Uji K", coaAccountId: c1.id, marketplace: true, aliases: "dompetkk" }, update: {} })).id;
  dest = (await prisma.bankAccount.upsert({ where: { code: "SEABANK_K" }, create: { code: "SEABANK_K", name: `Seabank Uji K ${LAST4}`, coaAccountId: c2.id, aliases: "rekkk" }, update: {} })).id;
  await prisma.setting.upsert({ where: { key: WD_TIKTOK_BANK_SETTING }, create: { key: WD_TIKTOK_BANK_SETTING, value: LAST4 }, update: { value: LAST4 } });
  transit = (await transitAccount(prisma)).id;
});

describe("Screenshot Detail penarikan dana Seller Center", () => {
  it("membaca contoh user: Pengajuan 9 Nov 20:58, Berhasil ditransfer 10 Nov 07:34, Rp649.690, ****5984, No. Referensi", () => {
    const t = "Detail penarikan dana\nJumlah penarikan dana Rp649.690\nRekening bank ********5984\nNo. Referensi 378129218802204 7837\nBerhasil ditransfer 10/11/2026 07:34\nSedang diproses\nPengajuan 09/11/2026 20:58";
    expect(parseSellerWithdrawal(t)).toEqual({ amount: 649_690, last4: "5984", ref: "3781292188022047837", submitted: { date: "2026-11-09", time: "20:58" }, transferred: { date: "2026-11-10", time: "07:34" } });
    // Bukti "Uang diterima": tanggal/jam = Berhasil ditransfer, tanpa catatan 1–3 hari
    expect(readWdProofText(t)).toMatchObject({ amount: 649_690, date: "2026-11-10", time: "07:34", source: "seller_done", ref: "3781292188022047837" });
    const p = parseSellerWithdrawal("Jumlah penarikan dana\nRp649.690\nRekening bank ********5984\nNo. Referensi\n378129218802204 7837\nSedang diproses\nPengajuan\n09/11/2026 20:58");
    expect(p).toMatchObject({ amount: 649_690, transferred: null, submitted: { date: "2026-11-09", time: "20:58" } });
    expect(readWdProofText("Detail penarikan dana\nJumlah penarikan dana Rp649.690\nSedang diproses\nPengajuan 09/11/2026 20:58").source).toBe("seller");
    expect(parseSellerWithdrawal("SeaBank\nUang Masuk\nRp463.256\n09 Nov 2026 08:18")).toBeNull();
  });

  it("sudah 'Berhasil ditransfer' → kartu tanpa catatan 1–3 hari, rekening 5984 otomatis, Simpan = langsung Dibukukan (2 jurnal)", async () => {
    const amt = uniq(649_000);
    const ref = refOf(1);
    const [b0, t0] = [await bal(dest), await coaBal(transit)];
    sent.length = 0;
    ocr.text = SHOT({ amount: amt, ref, done: true });
    await shot("WD dompetkk MG");
    const t = await last();
    expect(t).toMatchObject({ direction: "TRANSFER", accountId: seller, toAccountId: dest, status: "MENUNGGU_KONFIRMASI", withdrawRef: ref.replace(/\D/g, "") });
    expect(t.date.getTime()).toBe(jakartaDateTime("2026-11-09", "20:58").getTime());
    const card = sent.at(-1)!.text;
    expect(card).toContain("Berhasil ditransfer");
    expect(card).not.toContain("1–3 hari");
    expect(btns().map((x) => x.callback_data)).toEqual(expect.arrayContaining([`ok:${t.id}`, `no:${t.id}`]));
    expect(btns().some((x) => x.callback_data.startsWith("wr:"))).toBe(false);
    expect(btns().find((x) => x.callback_data === `ok:${t.id}`)?.text).toContain("dibukukan");
    await tap(`ok:${t.id}`);
    const done = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(done.status).toBe("DIBUKUKAN");
    expect(done.sentAt?.getTime()).toBe(jakartaDateTime("2026-11-09", "20:58").getTime());
    expect(done.receivedAt?.getTime()).toBe(jakartaDateTime("2026-11-10", "07:34").getTime());
    expect(done.receivedProofRead).toMatchObject({ source: "seller_done", manual: false });
    expect(await bal(dest)).toBe(b0 + amt);
    expect(await coaBal(transit)).toBe(t0);
    expect(await bal(seller)).toBe(0);
    expect(await prisma.journal.count({ where: { sourceId: t.id, source: { in: ["FINANCE", "WD_DITERIMA"] } } })).toBe(2);

    // Screenshot yang sama dikirim lagi = duplikat pasti (No. Referensi sama), tidak dicatat lagi
    sent.length = 0;
    await shot("WD dompetkk MG");
    expect(sent.at(-1)?.text).toContain("Duplikat");
    expect((await last()).id).toBe(t.id);
    expect(await bal(dest)).toBe(b0 + amt);
  });

  it("baru 'Sedang diproses' → Dalam Proses; screenshot kedua 'Berhasil ditransfer' (No. Ref sama) menyelesaikan otomatis", async () => {
    const amt = uniq(512_000);
    const ref = refOf(2);
    const b0 = await bal(dest);
    sent.length = 0;
    ocr.text = SHOT({ amount: amt, ref, done: false });
    await shot("WD dompetkk DL");
    const t = await last();
    expect(sent.at(-1)!.text).toContain("1–3 hari");
    expect(btns().find((x) => x.callback_data === `ok:${t.id}`)?.text).toContain("dalam proses");
    await tap(`ok:${t.id}`);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DALAM_PROSES");
    expect(await bal(dest)).toBe(b0);

    sent.length = 0;
    ocr.text = SHOT({ amount: amt, ref, done: true });
    await shot("");
    const done = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(done.status).toBe("DIBUKUKAN");
    expect(done.receivedAt?.getTime()).toBe(jakartaDateTime("2026-11-10", "07:34").getTime());
    expect(sent.at(-1)?.text).toContain("Uang diterima otomatis");
    expect(await bal(dest)).toBe(b0 + amt);
    expect(await prisma.financeTransaction.count({ where: { withdrawRef: ref.replace(/\D/g, "") } })).toBe(1);
  });

  it("WD Dalam Proses tanpa No. Ref (dicatat dari teks) diselesaikan screenshot dengan nominal + tanggal pengajuan sama", async () => {
    const amt = uniq(333_000);
    await say(`WD MG ${amt} tgl 09/11/2026 jam 20.58 dari dompetkk`);
    const t = await last();
    // Rekening tujuan tidak ditanya: otomatis rekening ****LAST4
    expect(t.toAccountId).toBe(dest);
    await tap(`ok:${t.id}`);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DALAM_PROSES");
    const ref = refOf(3);
    ocr.text = SHOT({ amount: amt, ref, done: true });
    await shot("");
    const done = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(done.status).toBe("DIBUKUKAN");
    expect(done.withdrawRef).toBe(ref.replace(/\D/g, ""));
  });

  it("4 digit rekening di bukti berbeda → peringatan", async () => {
    sent.length = 0;
    ocr.text = SHOT({ amount: uniq(211_000), ref: refOf(4), last4: "1234", done: true });
    await shot("WD dompetkk MG");
    expect(sent.some((x) => x.text.includes("****1234"))).toBe(true);
    const t = await last();
    await tap(`no:${t.id}`);
  });

  it("cek mirip: No. Referensi sama = duplikat pasti walau nominal/tanggal lain", async () => {
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { withdrawRef: { not: null }, status: "DIBUKUKAN" } });
    const hits = await findSimilar(prisma, { direction: "TRANSFER", amount: 1, date: new Date("2030-01-01T00:00:00Z"), withdrawRef: t.withdrawRef });
    expect(hits[0]).toMatchObject({ id: t.id, score: 100 });
  });
});
