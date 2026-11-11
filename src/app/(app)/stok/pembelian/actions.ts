"use server";
import { action, str, optStr, int } from "@/lib/action";
import { assertPerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { cancelPurchase, createPurchase, termFor, lineAmounts } from "@/lib/purchase";
import { closePurchase, receivePurchase } from "@/lib/purchaseReceive";
import { matchAccount } from "@/lib/extract";
import { readReceipt, receiptReaderConfigured } from "@/lib/receipt";
import { isModelUnavailable } from "@/lib/ai";
import { MAX_PROOF_BYTES, MAX_PROOF_TEXT, saveProof } from "@/lib/storage";
import { jakartaDateTime, todayStr } from "@/lib/time";

const num = (x: FormDataEntryValue) => Number(String(x).replace(/\./g, "").replace(",", ".")) || 0;

export const savePurchase = action(
  "finance.approve",
  async (fd, user) => {
    const items = fd.getAll("itemId").map(String);
    const qty = fd.getAll("qty").map(num);
    const totals = fd.getAll("lineTotal").map(num);
    const receipts = fd.getAll("receiptId").map(String);
    const lines = items.map((itemId, i) => ({ itemId, qty: qty[i], amount: totals[i], receiptId: receipts[i] || null }));
    // Tagihan = total semua baris; status bayar ditentukan dari nominal yang dibayar
    const bill = lineAmounts(lines.filter((l) => l.itemId && l.qty > 0)).reduce((s, l) => s + l.amount, 0);
    const paid = int(fd, "paidAmount");
    const term = termFor(bill, paid);
    // Status barang: sudah diterima (stok langsung masuk) atau masih dikirim (stok masuk saat "Terima barang")
    const inTransit = str(fd, "delivery") === "DIKIRIM";
    const cod = inTransit && str(fd, "cod") === "on";
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
        // Toko hanya untuk penarikan saldo penjual; bahan baku satu gudang → pakai toko default
        storeId: (await prisma.setting.findUniqueOrThrow({ where: { key: "default_store_id" } })).value,
        date: jakartaDateTime(str(fd, "date") || todayStr(), "12:00"),
        term,
        lines,
        paidNow: term === "BERTAHAP" ? paid : 0,
        bankAccountId: paid > 0 ? optStr(fd, "bankAccountId") : null,
        dueDate: term !== "LUNAS" && !cod && optStr(fd, "dueDate") ? jakartaDateTime(str(fd, "dueDate"), "12:00") : null,
        inTransit,
        cod,
        note: optStr(fd, "note"),
        proofPath,
        proofMime,
      },
      user,
    );
    if (inTransit) return `Pesanan ${p.number} tercatat (menunggu barang datang${cod ? ", COD" : paid > 0 ? ", uang muka tercatat" : ""}). Stok bertambah saat barang diterima.`;
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
  if (file.size > MAX_PROOF_BYTES) return { ok: false, error: MAX_PROOF_TEXT };
  if (!receiptReaderConfigured()) return { ok: false, error: "Pembaca foto (AI) belum diatur di server. Isi nominal manual." };
  const banks = await prisma.bankAccount.findMany({ where: { active: true } });
  let quota = false;
  const r = await readReceipt(Buffer.from(await file.arrayBuffer()), "bukti bayar pembelian bahan baku ke supplier", banks, file.type).catch((e) => {
    console.error("readPaymentProof gagal:", e);
    quota = e instanceof Error && isModelUnavailable(0, e.message);
    return null;
  });
  if (quota) return { ok: false, error: "Kuota model AI di penyedia sedang habis, jadi foto belum bisa dibaca. Isi nominal manual dulu ya." };
  if (!r || !r.amount) return { ok: false, error: "Nominal tidak terbaca dari foto. Isi manual ya." };
  return { ok: true, amount: r.amount, date: r.date, bankAccountId: r.account ? matchAccount(r.account, banks) : null, counterparty: r.counterparty };
}

/** Batalkan pembelian salah input: jurnal dibalik, stok keluar lagi, hutangnya dihapus */
export const cancelPurchaseAction = action(
  "finance.approve",
  async (fd, user) => {
    const p = await cancelPurchase(str(fd, "id"), str(fd, "reason"), user);
    return `Pembelian ${p.number} dibatalkan`;
  },
  ["/stok", "/akuntansi/piutang-utang", "/supplier"],
);

/** Terima barang pesanan (Supervisor / Kapten): isi jumlah yang datang per barang + foto barang/nota */
export const receivePurchaseAction = action(
  "stock.receive",
  async (fd, user) => {
    const lineIds = fd.getAll("lineId").map(String);
    const qtys = fd.getAll("recvQty").map(num);
    let photoPath: string | null = null;
    let photoMime: string | null = null;
    const file = fd.get("photo");
    if (file instanceof File && file.size > 0) {
      photoMime = file.type;
      photoPath = await saveProof(Buffer.from(await file.arrayBuffer()), file.type);
    }
    const r = await receivePurchase(
      {
        purchaseId: str(fd, "purchaseId"),
        // Hari ini = jam sekarang; tanggal lampau = pukul 12.00 WIB
        date: !str(fd, "date") || str(fd, "date") === todayStr() ? new Date() : jakartaDateTime(str(fd, "date"), "12:00"),
        lines: lineIds.map((lineId, i) => ({ lineId, qty: qtys[i] })),
        bankAccountId: optStr(fd, "bankAccountId"),
        photoPath,
        photoMime,
        note: optStr(fd, "note"),
      },
      user,
    );
    return `Barang diterima (${r.receipt.number})${r.done ? ", pesanan lengkap" : ", sisa masih ditunggu"}${r.payable ? `. Hutang ${r.payable.number} Rp ${r.rest.toLocaleString("id-ID")}` : ""}`;
  },
  ["/stok", "/akuntansi/piutang-utang", "/supplier", "/"],
);

/** Tutup pesanan yang sisanya tidak datang: uang muka sisa jadi piutang refund ke supplier */
export const closePurchaseAction = action(
  "finance.approve",
  async (fd, user) => {
    const r = await closePurchase(str(fd, "id"), str(fd, "reason"), user);
    return r.receivable ? `Pesanan ditutup. Refund Rp ${r.refund.toLocaleString("id-ID")} dicatat sebagai piutang ${r.receivable.number}` : "Pesanan ditutup";
  },
  ["/stok", "/akuntansi/piutang-utang", "/"],
);
