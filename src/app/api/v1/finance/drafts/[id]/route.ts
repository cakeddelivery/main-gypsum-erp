import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, authenticateApi, withIdempotency } from "@/lib/apiAuth";
import { FinanceError, submitForConfirmation, updateTransaction, missingFields } from "@/lib/finance";
import { present, telegramActor } from "../shared";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await authenticateApi(req, "finance:read");
  if (a.error) return a.error;
  const { id } = await params;
  const t = await prisma.financeTransaction.findFirst({ where: { OR: [{ id }, { number: id }] } });
  if (!t) return apiError(404, "not_found", "Transaksi tidak ditemukan");
  return NextResponse.json({ data: present(t) });
}

const patch = z.object({
  telegram_user_id: z.string().regex(/^\d+$/),
  account_code: z.string().optional(),
  to_account_code: z.string().optional(),
  category_id: z.string().optional(),
  amount: z.number().int().positive().optional(),
  note: z.string().max(1000).optional(),
  /** Tandai draft lengkap & siap dikonfirmasi manusia (bukan membukukan) */
  ready: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await authenticateApi(req, "finance:draft");
  if (a.error) return a.error;
  const { id } = await params;
  const parsed = patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return apiError(400, "invalid_body", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const b = parsed.data;
  return withIdempotency(req, a.client.id, async () => {
    const actor = await telegramActor(b.telegram_user_id);
    if (!actor) return { status: 403, body: { error: { code: "telegram_not_authorized", message: "ID Telegram belum dipetakan/diizinkan" } } };
    try {
      const [acc, to] = await Promise.all([b.account_code ? prisma.bankAccount.findUnique({ where: { code: b.account_code } }) : null, b.to_account_code ? prisma.bankAccount.findUnique({ where: { code: b.to_account_code } }) : null]);
      let t = await updateTransaction(id, { ...(acc ? { accountId: acc.id } : {}), ...(to ? { toAccountId: to.id } : {}), ...(b.category_id ? { categoryId: b.category_id } : {}), ...(b.amount ? { amount: b.amount } : {}), ...(b.note !== undefined ? { note: b.note } : {}) }, actor);
      if (b.ready && !t.duplicateOfId && missingFields(t).length === 0) t = await submitForConfirmation(id, actor, "Dilengkapi oleh Hermes");
      return { status: 200, body: { data: present(t) } };
    } catch (e) {
      if (e instanceof FinanceError) return { status: 422, body: { error: { code: "validation", message: e.message } } };
      throw e;
    }
  });
}
