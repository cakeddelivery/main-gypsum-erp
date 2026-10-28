import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, authenticateApi, withIdempotency } from "@/lib/apiAuth";
import { createTransaction, FinanceError } from "@/lib/finance";
import { saveProof } from "@/lib/storage";
import { jakartaDateTime } from "@/lib/time";
import { draftMessage } from "@/lib/bot";
import { sendTelegram, telegramConfigured } from "@/lib/telegram";
import { present, telegramActor } from "./shared";
import type { TxStatus } from "@prisma/client";

const schema = z.object({
  telegram_user_id: z.string().regex(/^\d+$/),
  direction: z.enum(["MASUK", "KELUAR", "TRANSFER"]),
  amount: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/),
  account_code: z.string().optional(),
  to_account_code: z.string().optional(),
  category_id: z.string().optional(),
  store_code: z.string().optional(),
  counterparty: z.string().max(200).optional(),
  note: z.string().max(1000).optional(),
  raw_text: z.string().max(4000).optional(),
  telegram_chat_id: z.string().optional(),
  proof_base64: z.string().max(7_500_000).optional(),
  proof_mime: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]).optional(),
  ai_extraction: z.record(z.unknown()).optional(),
  notify: z.boolean().optional(),
});

export async function GET(req: Request) {
  const a = await authenticateApi(req, "finance:read");
  if (a.error) return a.error;
  const status = new URL(req.url).searchParams.get("status") as TxStatus | null;
  const rows = await prisma.financeTransaction.findMany({ where: { ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: 50 });
  return NextResponse.json({ data: rows.map(present) });
}

/** Hermes membuat DRAFT transaksi (tidak pernah jurnal final) */
export async function POST(req: Request) {
  const a = await authenticateApi(req, "finance:draft");
  if (a.error) return a.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return apiError(400, "invalid_body", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const b = parsed.data;
  return withIdempotency(req, a.client.id, async () => {
    const actor = await telegramActor(b.telegram_user_id);
    if (!actor) return { status: 403, body: { error: { code: "telegram_not_authorized", message: "ID Telegram belum dipetakan/diizinkan" } } };
    const [acc, to, store] = await Promise.all([
      b.account_code ? prisma.bankAccount.findUnique({ where: { code: b.account_code } }) : null,
      b.to_account_code ? prisma.bankAccount.findUnique({ where: { code: b.to_account_code } }) : null,
      b.store_code ? prisma.store.findUnique({ where: { code: b.store_code } }) : null,
    ]);
    let proofPath: string | null = null;
    try {
      if (b.proof_base64 && b.proof_mime) proofPath = await saveProof(Buffer.from(b.proof_base64, "base64"), b.proof_mime);
      const [d, t] = b.date.split("T");
      const { transaction, duplicate } = await createTransaction(
        {
          direction: b.direction,
          amount: b.amount,
          date: jakartaDateTime(d, t ?? "12:00"),
          accountId: acc?.id ?? null,
          toAccountId: to?.id ?? null,
          categoryId: b.category_id ?? null,
          suggestedCategoryId: b.category_id ?? null,
          storeId: store?.id ?? null,
          counterparty: b.counterparty ?? null,
          note: b.note ?? null,
          rawText: b.raw_text ?? null,
          proofPath,
          proofMime: proofPath ? b.proof_mime! : null,
          aiExtraction: (b.ai_extraction as object) ?? null,
          telegramChatId: b.telegram_chat_id ?? null,
        },
        "AI",
        actor,
      );
      if (b.notify && b.telegram_chat_id && telegramConfigured()) {
        const m = await draftMessage(transaction.id);
        await sendTelegram(b.telegram_chat_id, `📝 Draft dari Hermes (belum dibukukan)\n\n${m.text}`, { buttons: m.buttons, type: "DRAFT" });
      }
      return { status: 201, body: { data: present(transaction), duplicate_of: duplicate?.number ?? null } };
    } catch (e) {
      if (e instanceof FinanceError || (e instanceof Error && /bukti|Format|Ukuran|Isi file/.test(e.message))) return { status: 422, body: { error: { code: "validation", message: e.message } } };
      throw e;
    }
  });
}
