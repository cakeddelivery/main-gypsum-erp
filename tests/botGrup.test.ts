import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Bot ERP di grup Telegram: Owner & tim mencatat di grup yang sama tanpa saling menimpa isian */
const sent: { chat: string; text: string; buttons?: { text: string; callback_data: string }[][] }[] = [];
const answers: string[] = [];
vi.mock("@/lib/telegram", async (orig) => {
  const real = await orig<typeof import("@/lib/telegram")>();
  return {
    ...real,
    sendTelegram: vi.fn(async (c: string, text: string, o: { buttons?: { text: string; callback_data: string }[][] } = {}) => (sent.push({ chat: c, text, buttons: o.buttons }), { ok: true, result: { message_id: 9000 + sent.length } })),
    editTelegram: vi.fn(async (c: string, _m: number, text: string, buttons?: { text: string; callback_data: string }[][]) => (sent.push({ chat: c, text, buttons }), { ok: true })),
    answerCallback: vi.fn(async (_id: string, text: string) => (answers.push(text), { ok: true })),
    telegramConfigured: () => true,
    chatAction: vi.fn(async () => ({ ok: true })),
  };
});

import { prisma } from "@/lib/db";
import { handleTelegramUpdate } from "@/lib/bot";
import { messageBody, withReplyTo } from "@/lib/telegram";
import { GROUP_RECAP_SETTING, GROUP_REMINDER_OFF, GROUP_SETTING, normalizeCommand, reminderGroups } from "@/lib/botGroup";
import { sendBalanceCheck } from "@/lib/balanceCheck";
import { jakartaDateTime } from "@/lib/time";

const G = -1001234567890;
const OTHER_G = -1009999999999;
const A = { id: 778001, first_name: "Edy" };
const B = { id: 778002, first_name: "Admin" };
const C = { id: 778003, first_name: "Finance" };
const STRANGER = { id: 778099, first_name: "Tamu" };
let n = 1_200_000;
let uid: Record<string, string> = {};
const say = (from: { id: number; first_name: string }, text: string, chat = G, extra: object = {}) =>
  handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat: { id: chat }, from, text, ...extra } } as never);
/** Tekan tombol pada kartu yang membalas pesan `owner` */
const tap = (from: { id: number; first_name: string }, data: string, owner?: { id: number; first_name: string }, chat = G) =>
  handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 5, chat: { id: chat }, ...(owner ? { reply_to_message: { message_id: 4, from: owner } } : {}) } } } as never);
const key = (who: string) => `${G}:${uid[who]}`;

beforeAll(async () => {
  for (const [tg, username] of [[A, "owner"], [B, "admin"], [C, "finance"]] as const) {
    const u = await prisma.user.findUniqueOrThrow({ where: { username } });
    uid[username] = u.id;
    await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(tg.id) }, create: { telegramUserId: String(tg.id), userId: u.id }, update: { active: true, chatId: null } });
  }
  await prisma.setting.deleteMany({ where: { key: GROUP_SETTING } });
  const sup = await prisma.supplier.upsert({ where: { code: "SUP_UJI_GRUP" }, create: { code: "SUP_UJI_GRUP", name: "Toko Uji Grup" }, update: {} });
  await prisma.item.upsert({ where: { sku: "BB-UJI-GRUP" }, create: { sku: "BB-UJI-GRUP", name: "Lem Uji Grup", type: "BAHAN_BAKU", unit: "pcs", supplierId: sup.id }, update: { active: true } });
});
// Grup uji dihapus lagi agar pengingat/rekap di tes lain tidak ikut terkirim ke grup
afterAll(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: [GROUP_SETTING, GROUP_RECAP_SETTING, GROUP_REMINDER_OFF] } } });
  await prisma.telegramIdentity.update({ where: { telegramUserId: String(A.id) }, data: { chatId: null } });
});
beforeEach(() => {
  sent.length = 0;
  answers.length = 0;
});

describe("Bot di grup Telegram", () => {
  it("grup belum terdaftar didiamkan; hanya Owner yang bisa /daftargrup", async () => {
    await say(A, "beli lem uji grup 10 pcs 20rb dari seabank");
    expect(sent).toHaveLength(0);
    await say(A, "/id");
    expect(sent.at(-1)!.text).toContain(String(G));
    await say(B, "/daftargrup");
    expect(sent.at(-1)!.text).toContain("Hanya Owner");
    await say(A, "/daftargrup@MainGypsumErpBot");
    expect(sent.at(-1)!.text).toContain("Grup ini terdaftar");
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: GROUP_SETTING } })).value).toContain(String(G));
    // Grup lain tetap didiamkan, termasuk tombolnya
    sent.length = 0;
    await say(A, "/menu", OTHER_G);
    expect(sent).toHaveLength(0);
    await tap(A, "m:home", A, OTHER_G);
    expect(answers.at(-1)).toContain("belum didaftarkan");
  });

  it("obrolan biasa & pengirim tak terdaftar diabaikan; /menu@Bot dilayani", async () => {
    await say(A, "halo semua, nanti sore rapat ya");
    await say(STRANGER, "beli lem 20rb");
    await say(STRANGER, "/menu");
    expect(sent).toHaveLength(0);
    await say(A, "/menu@MainGypsumErpBot");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((m) => m.chat === String(G))).toBe(true);
    // Chat grup tidak disimpan sebagai chat pribadi (notifikasi pribadi tetap ke chat pribadi)
    expect((await prisma.telegramIdentity.findUniqueOrThrow({ where: { telegramUserId: String(A.id) } })).chatId).toBeNull();
  });

  it("dua orang mengisi bersamaan tidak saling menimpa; jawaban hanya ke sesi pengirim", async () => {
    await say(A, "beli lem uji grup 10 pcs 21rb dari seabank");
    await say(C, "beli lem uji grup 30 pcs 63rb dari seabank");
    const sa = await prisma.botSession.findUniqueOrThrow({ where: { chatId: key("owner") } });
    const sc = await prisma.botSession.findUniqueOrThrow({ where: { chatId: key("finance") } });
    expect([sa.flow, sc.flow]).toEqual(["beli", "beli"]);
    expect(JSON.parse(String((sa.data as Record<string, unknown>).lines))[0].amount).toBe(21_000);
    expect(JSON.parse(String((sc.data as Record<string, unknown>).lines))[0].amount).toBe(63_000);
    expect(await prisma.botSession.findUnique({ where: { chatId: String(G) } })).toBeNull();

    // Admin menekan kartu milik Edy → ditolak
    const before = await prisma.purchase.count();
    await tap(B, "f:ok", A);
    expect(answers.at(-1)).toBe("Kartu ini milik Edy");
    expect(await prisma.purchase.count()).toBe(before);

    // Edy menyimpan kartunya: hanya pembelian Edy yang tercatat, isian Finance utuh
    await tap(A, "f:ok", A);
    expect(await prisma.purchase.count()).toBe(before + 1);
    expect(Number((await prisma.purchase.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).total)).toBe(21_000);
    expect(await prisma.botSession.findUnique({ where: { chatId: key("owner") } })).toBeNull();
    expect((await prisma.botSession.findUniqueOrThrow({ where: { chatId: key("finance") } })).flow).toBe("beli");

    // Owner/Finance boleh menekan kartu orang lain: Edy menyimpan kartu milik Finance → isian Finance yang dipakai
    await tap(A, "f:ok", C);
    expect(await prisma.purchase.count()).toBe(before + 2);
    expect(Number((await prisma.purchase.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).total)).toBe(63_000);
  });

  it("chat pribadi tetap seperti sebelumnya (kunci sesi = id chat)", async () => {
    await say(A, "beli lem uji grup 5 pcs 11rb dari seabank", A.id);
    expect((await prisma.botSession.findUniqueOrThrow({ where: { chatId: String(A.id) } })).flow).toBe("beli");
    await prisma.botSession.deleteMany({ where: { chatId: String(A.id) } });
  });

  it("perintah dengan nama bot & balasan ke pesan pengirim di grup", async () => {
    expect(normalizeCommand("/menu@MainGypsumErpBot")).toBe("/menu");
    expect(normalizeCommand("/rekap@Bot_1 kemarin")).toBe("/rekap kemarin");
    const inGroup = await withReplyTo(String(G), 42, async () => messageBody(String(G), "hai"));
    expect(inGroup).toMatchObject({ reply_parameters: { message_id: 42 } });
    const priv = await withReplyTo(String(A.id), 42, async () => messageBody(String(A.id), "hai"));
    expect(priv).not.toHaveProperty("reply_parameters");
  });

  it("cek saldo pagi juga ke grup; dijawab di grup → kartu di chat pribadi ikut diperbarui; /pengingatgrup", async () => {
    // Edy punya chat pribadi (penerima cek saldo sebagai Owner)
    await prisma.telegramIdentity.update({ where: { telegramUserId: String(A.id) }, data: { chatId: String(A.id) } });
    await sendBalanceCheck(jakartaDateTime("2033-04-02", "05:01"));
    const groupCard = sent.find((m) => m.chat === String(G) && m.text.includes("Cek saldo pagi"));
    expect(groupCard).toBeTruthy();
    expect(sent.some((m) => m.chat === String(A.id) && m.text.includes("Cek saldo pagi"))).toBe(true);
    const row = await prisma.balanceCheck.findFirstOrThrow({ where: { date: new Date("2033-04-01T00:00:00Z") }, include: { bankAccount: true } });
    sent.length = 0;
    // Finance menjawab di grup (kartu sistem, bukan balasan ke orang) → status sama, kartu pribadi Edy ikut diedit
    await tap(C, `cs:ok:${row.id}`);
    expect((await prisma.balanceCheck.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("SESUAI");
    const priv = sent.filter((m) => m.chat === String(A.id));
    expect(priv.length).toBeGreaterThan(0);
    expect(priv.at(-1)!.text).toContain("oleh Staf Finance");

    expect(await reminderGroups()).toContain(String(G));
    await say(B, "/pengingatgrup");
    expect(await reminderGroups()).toContain(String(G));
    await say(A, "/pengingatgrup");
    expect(sent.at(-1)!.text).toContain("dimatikan");
    expect(await reminderGroups()).not.toContain(String(G));
    await say(A, "/pengingatgrup");
    expect(await reminderGroups()).toContain(String(G));
  });
});
