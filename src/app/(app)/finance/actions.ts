"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, optStr, int } from "@/lib/action";
import { approveAndBook, createTransaction, rejectTransaction, submitForConfirmation, updateTransaction, type TxInput } from "@/lib/finance";
import { saveProof } from "@/lib/storage";
import { extractTransaction } from "@/lib/extract";
import { jakartaDateTime } from "@/lib/time";
import { assertPerm } from "@/lib/auth";
import type { TxDirection } from "@prisma/client";

async function readForm(fd: FormData): Promise<TxInput> {
  const direction = z.enum(["MASUK", "KELUAR", "TRANSFER"]).parse(str(fd, "direction")) as TxDirection;
  const date = str(fd, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Tanggal wajib diisi");
  const time = str(fd, "time") || "12:00";
  let proofPath: string | null = null;
  let proofMime: string | null = null;
  const file = fd.get("proof");
  if (file && typeof file === "object" && "arrayBuffer" in file && file.size > 0) {
    proofMime = file.type;
    proofPath = await saveProof(Buffer.from(await file.arrayBuffer()), file.type);
  }
  return {
    direction,
    amount: int(fd, "amount"),
    date: jakartaDateTime(date, time),
    accountId: optStr(fd, "accountId"),
    toAccountId: optStr(fd, "toAccountId"),
    categoryId: optStr(fd, "categoryId"),
    suggestedCategoryId: optStr(fd, "suggestedCategoryId"),
    storeId: optStr(fd, "storeId"),
    counterparty: optStr(fd, "counterparty"),
    note: optStr(fd, "note"),
    rawText: optStr(fd, "rawText"),
    proofPath,
    proofMime,
  };
}

export const createTx = action(
  "finance.create",
  async (fd, user) => {
    const input = await readForm(fd);
    const submit = str(fd, "intent") === "submit";
    const { transaction, duplicate } = await createTransaction({ ...input, idempotencyKey: optStr(fd, "formKey") ? `web:${user.id}:${str(fd, "formKey")}` : null }, "MANUAL", { id: user.id, name: user.name }, { submit });
    redirect(`/finance/${transaction.id}${duplicate ? "?dup=1" : ""}`);
  },
  ["/finance", "/"],
);

export const updateTx = action(
  "finance.create",
  async (fd, user) => {
    const input = await readForm(fd);
    await updateTransaction(str(fd, "id"), { ...input, proofPath: input.proofPath ?? undefined, proofMime: input.proofMime ?? undefined }, { id: user.id, name: user.name });
    return "Perubahan tersimpan";
  },
  ["/finance"],
);

export const submitTx = action(["finance.create", "finance.review"], async (fd, user) => {
  await submitForConfirmation(str(fd, "id"), { id: user.id, name: user.name }, optStr(fd, "note") ?? undefined);
  return "Diajukan untuk konfirmasi";
}, ["/finance", "/"]);

export const approveTx = action("finance.approve", async (fd, user) => {
  const { journal } = await approveAndBook(str(fd, "id"), { id: user.id, name: user.name }, optStr(fd, "note") ?? undefined);
  return `Disetujui & dibukukan (${journal.number})`;
}, ["/finance", "/", "/akuntansi"]);

export const rejectTx = action(["finance.review", "finance.approve"], async (fd, user) => {
  await rejectTransaction(str(fd, "id"), { id: user.id, name: user.name }, str(fd, "reason"));
  return "Transaksi ditolak";
}, ["/finance", "/"]);

/** Ekstraksi teks (fallback aturan) untuk membantu pengisian form */
export async function extractAction(text: string) {
  await assertPerm("finance.create");
  const [banks, cats] = await Promise.all([prisma.bankAccount.findMany({ where: { active: true } }), prisma.txCategory.findMany({ where: { active: true } })]);
  return extractTransaction(text, banks, cats);
}
