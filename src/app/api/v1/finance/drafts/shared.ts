import { prisma } from "@/lib/db";
import { STATUS_LABEL } from "@/lib/finance";
import type { FinanceTransaction } from "@prisma/client";

export async function telegramActor(telegramUserId: string) {
  const ident = await prisma.telegramIdentity.findUnique({ where: { telegramUserId }, include: { user: true } });
  if (!ident || !ident.active || !ident.user.active || !ident.canSubmit) return null;
  return { id: ident.userId, name: ident.user.name, telegramId: ident.telegramUserId };
}

export function present(t: FinanceTransaction) {
  return {
    id: t.id,
    number: t.number,
    status: t.status,
    status_label: STATUS_LABEL[t.status],
    source: t.source,
    direction: t.direction,
    amount: Number(t.amount),
    currency: "IDR",
    date: t.date.toISOString(),
    account_id: t.accountId,
    to_account_id: t.toAccountId,
    category_id: t.categoryId,
    store_id: t.storeId,
    note: t.note,
    duplicate_of: t.duplicateOfId,
    booked: t.status === "DIBUKUKAN",
  };
}
