import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { generateApiKey } from "@/lib/apiAuth";
import { POST as createDraft } from "@/app/api/v1/finance/drafts/route";
import { PATCH as patchDraft } from "@/app/api/v1/finance/drafts/[id]/route";
import { GET as accounts } from "@/app/api/v1/finance/accounts/route";
import { POST as webhook } from "@/app/api/telegram/webhook/route";

let fullKey = "";
let readOnlyKey = "";
const TG = "555000111";

beforeAll(async () => {
  const k = generateApiKey();
  await prisma.apiClient.create({ data: { name: "Hermes test", keyPrefix: k.prefix, keyHash: k.hash, scopes: "finance:read,finance:draft" } });
  fullKey = k.key;
  const r = generateApiKey();
  await prisma.apiClient.create({ data: { name: "Read only", keyPrefix: r.prefix, keyHash: r.hash, scopes: "finance:read" } });
  readOnlyKey = r.key;
  const fin = await prisma.user.findUniqueOrThrow({ where: { username: "finance" } });
  await prisma.telegramIdentity.create({ data: { telegramUserId: TG, userId: fin.id, canSubmit: true, canConfirm: true } });
  process.env.TELEGRAM_WEBHOOK_SECRET = "secret-for-test";
});

const req = (url: string, key: string, body?: unknown, headers: Record<string, string> = {}, method = "POST") =>
  new Request(`http://x${url}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });

const draftBody = { telegram_user_id: TG, direction: "KELUAR", amount: 123_456, date: "2026-09-20", account_code: "KAS", note: "Ongkir JNE" };

describe("Finance API v1 (Hermes)", () => {
  it("menolak tanpa API key / scope kurang / tanpa Idempotency-Key", async () => {
    expect((await accounts(new Request("http://x/api/v1/finance/accounts"))).status).toBe(401);
    expect((await createDraft(req("/d", readOnlyKey, draftBody, { "idempotency-key": "k-12345678" }))).status).toBe(403);
    expect((await createDraft(req("/d", fullKey, draftBody))).status).toBe(400);
  });

  it("membuat draft (bukan jurnal) & idempoten", async () => {
    const r1 = await createDraft(req("/d", fullKey, draftBody, { "idempotency-key": "hermes-0001" }));
    expect(r1.status).toBe(201);
    const j1 = await r1.json();
    expect(j1.data.booked).toBe(false);
    const r2 = await createDraft(req("/d", fullKey, draftBody, { "idempotency-key": "hermes-0001" }));
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect((await r2.json()).data.id).toBe(j1.data.id);
    expect(await prisma.journal.count({ where: { sourceId: j1.data.id } })).toBe(0);
  });

  it("PATCH ready memindahkan ke Menunggu Konfirmasi, tetap tidak dibukukan", async () => {
    const r1 = await createDraft(req("/d", fullKey, { ...draftBody, amount: 98_765 }, { "idempotency-key": "hermes-0002" }));
    const { data } = await r1.json();
    const cat = await prisma.txCategory.findFirstOrThrow({ where: { name: "Ongkos Kirim" } });
    const res = await patchDraft(req(`/d/${data.id}`, fullKey, { telegram_user_id: TG, category_id: cat.id, ready: true }, { "idempotency-key": "hermes-0003" }, "PATCH"), { params: Promise.resolve({ id: data.id }) });
    const j = await res.json();
    expect(j.data.status).toBe("MENUNGGU_KONFIRMASI");
    expect(j.data.booked).toBe(false);
  });

  it("ID Telegram yang tidak terdaftar ditolak", async () => {
    const r = await createDraft(req("/d", fullKey, { ...draftBody, telegram_user_id: "1" }, { "idempotency-key": "hermes-0004" }));
    expect(r.status).toBe(403);
  });
});

describe("Webhook Telegram", () => {
  const post = (u: unknown, secret = "secret-for-test") => webhook(new Request("http://x/api/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json" }, body: JSON.stringify(u) }));

  it("menolak secret salah", async () => {
    expect((await post({}, "salah-secret-xxxxx")).status).toBe(403);
  });

  it("foto bukti + caption tanpa nominal, AI tidak tersedia → dibaca OCR server jadi draft", async () => {
    const { vi } = await import("vitest");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const img = readFileSync(join(__dirname, "fixtures", "bukti-seabank-qris.jpg"));
    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (!u.startsWith("https://api.telegram.org/")) return realFetch(url, init);
      if (u.includes("/file/bot")) return new Response(img);
      if (u.endsWith("/getFile")) return Response.json({ ok: true, result: { file_path: "photos/x.jpg" } });
      if (u.endsWith("/sendMessage")) sent.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true, result: { message_id: 1 } });
    });
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    try {
      await post({ update_id: 9, message: { message_id: 4700, chat: { id: Number(TG) }, from: { id: Number(TG) }, caption: "Isi ulang tabung LPG 2 pcs", photo: [{ file_id: "kecil" }, { file_id: "besar" }] } });
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = "";
      vi.unstubAllGlobals();
    }
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { telegramMessageId: "4700" } });
    const acc = await prisma.bankAccount.findUniqueOrThrow({ where: { id: t.accountId! } });
    expect(Number(t.amount)).toBe(40000);
    expect(t.direction).toBe("KELUAR");
    expect(acc.name).toMatch(/sea\s*bank/i);
    expect(t.note).toContain("Isi ulang tabung LPG");
    expect(sent.at(-1)).toContain("Draft dibuat");
  }, 60_000);

  it("pesan → draft; tombol konfirmasi oleh identitas berizin → dibukukan", async () => {
    await post({ update_id: 1, message: { message_id: 77, chat: { id: Number(TG) }, from: { id: Number(TG) }, text: "bayar listrik 410rb dari kas hari ini" } });
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { telegramMessageId: "77" } });
    expect(t.status).toBe("MENUNGGU_KONFIRMASI");
    // pesan sama dikirim ulang Telegram → tidak membuat draft ganda
    await post({ update_id: 1, message: { message_id: 77, chat: { id: Number(TG) }, from: { id: Number(TG) }, text: "bayar listrik 410rb dari kas hari ini" } });
    expect(await prisma.financeTransaction.count({ where: { telegramMessageId: "77" } })).toBe(1);
    await post({ update_id: 2, callback_query: { id: "c1", from: { id: Number(TG) }, data: `ok:${t.id}`, message: { message_id: 78, chat: { id: Number(TG) } } } });
    const after = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.status).toBe("DIBUKUKAN");
  });

  it("identitas tanpa izin konfirmasi tidak bisa membukukan", async () => {
    const op = await prisma.user.findUniqueOrThrow({ where: { username: "operator" } });
    await prisma.telegramIdentity.create({ data: { telegramUserId: "42", userId: op.id, canSubmit: true, canConfirm: true } });
    const t = await prisma.financeTransaction.findFirstOrThrow({ where: { status: "MENUNGGU_KONFIRMASI" } });
    await post({ update_id: 3, callback_query: { id: "c2", from: { id: 42 }, data: `ok:${t.id}` } });
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("MENUNGGU_KONFIRMASI");
  });

  it("menu tombol mengikuti izin peran; tombol 📋 Menu tidak membuat draft transaksi", async () => {
    const before = await prisma.financeTransaction.count();
    await post({ update_id: 4, message: { message_id: 90, chat: { id: 42 }, from: { id: 42 }, text: "📋 Menu" } });
    expect(await prisma.financeTransaction.count()).toBe(before);
    const menu = await prisma.notificationLog.findFirstOrThrow({ where: { type: "MENU", target: "42", payload: { contains: "Pilih menu" } }, orderBy: { at: "desc" } });
    expect(menu.payload).toContain("Menu ERP");
    const { mainMenu } = await import("@/lib/botMenu");
    const { effectivePermissions } = await import("@/lib/rbac");
    const ident = (role: "OPERATOR" | "FINANCE") => ({ userId: "u", canSubmit: true, perms: effectivePermissions(role, []), user: { name: "X", role, divisionId: null, employeeId: "e" } });
    const op = mainMenu(ident("OPERATOR")).buttons.flat().map((b) => b.callback_data);
    const fin = mainMenu(ident("FINANCE")).buttons.flat().map((b) => b.callback_data);
    expect(op).not.toContain("m:tx");
    expect(op).not.toContain("m:rkp");
    expect(fin).toEqual(expect.arrayContaining(["m:sum", "m:rpt", "m:tx", "m:rkp"]));
  });

  it("isian bertahap: operator input produksi + reject lewat tombol & teks", async () => {
    const cb = (data: string, n: number) => post({ update_id: 100 + n, callback_query: { id: `cb${n}`, from: { id: 42 }, data, message: { message_id: 200, chat: { id: 42 } } } });
    const msg = (text: string, n: number) => post({ update_id: 100 + n, message: { message_id: 300 + n, date: Math.floor(Date.now() / 1000), chat: { id: 42 }, from: { id: 42 }, text } });
    const shift = await prisma.shift.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    const product = await prisma.product.findFirstOrThrow({ where: { active: true } });
    await cb("f:start:prod", 1);
    await cb("f:0", 2);
    if ((await prisma.shift.count({ where: { active: true } })) > 1) await cb(`f:${shift.id}`, 3);
    await cb("f:CETAK", 4);
    await cb(`f:${product.id}`, 5);
    await msg("abc", 6); // bukan angka: tetap di langkah yang sama
    expect((await prisma.botSession.findUniqueOrThrow({ where: { chatId: "42" } })).step).toBe("good");
    await msg("1.250", 7);
    await msg("3", 8);
    await cb("f:2", 9);
    await cb("f:ok", 10);
    const e = await prisma.productionEntry.findFirstOrThrow({ where: { note: "Via Telegram" }, orderBy: { createdAt: "desc" } });
    expect([e.qtyGood, e.qtyReject, e.rejectReason, e.stage]).toEqual([1250, 3, "Cacat cetak", "CETAK"]);
    expect(await prisma.botSession.findUnique({ where: { chatId: "42" } })).toBeNull();
    // teks transaksi setelah isian selesai kembali dibaca sebagai transaksi
    expect(await prisma.financeTransaction.count({ where: { telegramChatId: "42", telegramMessageId: "307" } })).toBe(0);
  });

  it("absen lewat lokasi Telegram: tolak lokasi diteruskan & di luar area, terima di dalam area", async () => {
    await prisma.workSite.create({ data: { name: "Workshop tes", latitude: -7.12, longitude: 112.41, radiusM: 100 } });
    const op = await prisma.user.findUniqueOrThrow({ where: { username: "operator" } });
    await prisma.attendance.deleteMany({ where: { employeeId: op.employeeId! } });
    const loc = (lat: number, lng: number, n: number, extra = {}) => post({ update_id: 400 + n, message: { message_id: 400 + n, date: Math.floor(Date.now() / 1000), chat: { id: 42 }, from: { id: 42 }, location: { latitude: lat, longitude: lng, horizontal_accuracy: 15 }, ...extra } });
    await post({ update_id: 399, callback_query: { id: "a1", from: { id: 42 }, data: "f:start:absen", message: { message_id: 201, chat: { id: 42 } } } });
    await loc(-7.12, 112.41, 1, { forward_date: 1 });
    await loc(-7.2, 112.5, 2);
    const today = await prisma.attendance.count({ where: { employeeId: op.employeeId! } });
    expect(today).toBe(0);
    await loc(-7.1201, 112.4101, 3);
    const a = await prisma.attendance.findFirstOrThrow({ where: { employeeId: op.employeeId! } });
    expect(a.checkIn).not.toBeNull();
    expect(a.note).toBe("Absen via Telegram");
    expect(a.checkInDistance).toBeLessThanOrEqual(100);
    await prisma.workSite.deleteMany({ where: { name: "Workshop tes" } });
  });

  it("Tahap 3: finance memberi kasbon & mencatat pembelian lunas lewat bot", async () => {
    const id = Number(TG);
    let n = 600;
    const cb = (data: string) => post({ update_id: ++n, callback_query: { id: `k${n}`, from: { id }, data, message: { message_id: 700, chat: { id } } } });
    const msg = (text: string) => post({ update_id: ++n, message: { message_id: ++n, date: Math.floor(Date.now() / 1000), chat: { id }, from: { id }, text } });
    const op = await prisma.user.findUniqueOrThrow({ where: { username: "operator" } });
    const bank = await prisma.bankAccount.findFirstOrThrow({ where: { active: true }, orderBy: { code: "asc" } });
    await cb("f:start:ksb");
    await cb(`f:${op.employeeId}`);
    await msg("250rb");
    await cb("f:0");
    await cb(`f:${bank.id}`);
    await cb("f:skip");
    await cb("f:ok");
    const a = await prisma.cashAdvance.findFirstOrThrow({ where: { employeeId: op.employeeId! }, orderBy: { createdAt: "desc" } });
    expect([Number(a.amount), Number(a.installment), a.paidFromAccountId]).toEqual([250000, 0, bank.id]);

    const item = await prisma.item.findFirstOrThrow({ where: { active: true, type: "BAHAN_BAKU" } });
    await cb("f:start:beli");
    await msg("Supplier Bot Tes");
    await cb(`f:${item.id}`);
    await msg("3");
    await msg("90rb");
    await cb("f:done");
    await cb("f:full");
    await cb(`f:${bank.id}`);
    await cb("f:skip");
    await cb("f:ok");
    const p = await prisma.purchase.findFirstOrThrow({ where: { vendor: "Supplier Bot Tes" }, include: { lines: true } });
    expect([p.term, Number(p.total), p.lines.length, Number(p.lines[0].qty)]).toEqual(["LUNAS", 90000, 1, 3]);
    expect(await prisma.botSession.findUnique({ where: { chatId: TG } })).toBeNull();
  });

  it("operator tidak bisa memulai mutasi stok lewat bot", async () => {
    await post({ update_id: 500, callback_query: { id: "m1", from: { id: 42 }, data: "f:start:mut", message: { message_id: 202, chat: { id: 42 } } } });
    expect(await prisma.botSession.findUnique({ where: { chatId: "42" } })).toBeNull();
  });

  it("operator tidak bisa meminta JPG laporan keuangan lewat tombol", async () => {
    await post({ update_id: 5, callback_query: { id: "c3", from: { id: 42 }, data: "m:j:ak:cur", message: { message_id: 91, chat: { id: 42 } } } });
    expect(await prisma.notificationLog.count({ where: { type: "LAPORAN_JPG", target: "42" } })).toBe(0);
  });
});
