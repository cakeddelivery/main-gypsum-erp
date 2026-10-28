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
});
