"use server";
import { action, str, optStr, int } from "@/lib/action";
import { assertPerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createPurchase, termFor, lineAmounts } from "@/lib/purchase";
import { matchAccount } from "@/lib/extract";
import { readReceipt, receiptReaderConfigured } from "@/lib/receipt";
import { MAX_PROOF_BYTES, saveProof } from "@/lib/storage";
import { jakartaDateTime, todayStr } from "@/lib/time";

const num = (x: FormDataEntryValue) => Number(String(x).replace(/\./g, "").replace(",", ".")) || 0;

export const savePurchase = action(
  "finance.approve",
  async (fd, user) => {
    const items = fd.getAll("itemId").map(String);
    const qty = fd.getAll("qty").map(num);
    const totals = fd.getAll("lineTotal").map(num);
    const lines = items.map((itemId, i) => ({ itemId, qty: qty[i], amount: totals[i] }));
    // Tagihan = total semua baris; status bayar ditentukan dari nominal yang dibayar
    const bill = lineAmounts(lines.filter((l) => l.itemId && l.qty > 0)).reduce((s, l) => s + l.amount, 0);
    const paid = int(fd, "paidAmount");
    const term = termFor(bill, paid);
    let proofPath: string | null = null;
    let proofMime: string | null = null;
    const file = fd.get("proof");
    if (file instanceof File && file.size > 0) {
      proofMime = file.type;
      proofPath = await saveProof(Buffer.from(await file.arrayBuffer()), file.type);
    }
    const p = await createPurchase(
      {
        supplierId: optStr(fd, "supplierId"),
        newSupplierName: optStr(fd, "newSupplierName"),
        storeId: str(fd, "storeId"),
        date: jakartaDateTime(str(fd, "date") || todayStr(), "12:00"),
        term,
        lines,
        paidNow: term === "BERTAHAP" ? paid : 0,
        bankAccountId: paid > 0 ? optStr(fd, "bankAccountId") : null,
        dueDate: term !== "LUNAS" && optStr(fd, "dueDate") ? jakartaDateTime(str(fd, "dueDate"), "12:00") : null,
        note: optStr(fd, "note"),
        proofPath,
        proofMime,
      },
      user,
    );
    return `Pembelian ${p.number} tercatat${term === "LUNAS" ? " (lunas)" : " (hutang)"}`;
  },
  ["/stok", "/akuntansi/piutang-utang", "/supplier"],
);

export type ProofRead = { ok: boolean; error?: string; amount?: number | null; date?: string | null; bankAccountId?: string | null; counterparty?: string | null };

/** Baca nominal, tanggal & rekening sumber dari foto bukti transfer untuk mengisi form pembelian */
export async function readPaymentProof(fd: FormData): Promise<ProofRead> {
  await assertPerm("finance.approve");
  const file = fd.get("proof");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Pilih foto bukti transfer dulu" };
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return { ok: false, error: "Foto harus JPG, PNG, atau WEBP" };
  if (file.size > MAX_PROOF_BYTES) return { ok: false, error: "Ukuran foto maksimal 5 MB" };
  if (!receiptReaderConfigured()) return { ok: false, error: "Pembaca foto (AI) belum diatur di server. Isi nominal manual." };
  const banks = await prisma.bankAccount.findMany({ where: { active: true } });
  const r = await readReceipt(Buffer.from(await file.arrayBuffer()), "bukti bayar pembelian bahan baku ke supplier", banks, file.type).catch(() => null);
  if (!r || !r.amount) return { ok: false, error: "Nominal tidak terbaca dari foto. Isi manual ya." };
  return { ok: true, amount: r.amount, date: r.date, bankAccountId: r.account ? matchAccount(r.account, banks) : null, counterparty: r.counterparty };
}
