"use server";
import { action, str, optStr, int } from "@/lib/action";
import { cancelSale, cancelSalePayment, createSale, paySale } from "@/lib/sales";
import { StockError } from "@/lib/stock";
import { MAX_PROOF_BYTES, MAX_PROOF_TEXT, saveProof } from "@/lib/storage";
import { jakartaDateTime, todayStr } from "@/lib/time";

const num = (x: FormDataEntryValue) => Number(String(x).replace(/\./g, "").replace(",", ".")) || 0;
const day = (fd: FormData, k = "date") => jakartaDateTime(str(fd, k) || todayStr(), "12:00");
const PATHS = ["/penjualan", "/stok", "/akuntansi/piutang-utang", "/finance/mutasi", "/pelanggan"];

async function proofOf(fd: FormData) {
  const file = fd.get("proof");
  if (!(file instanceof File) || file.size === 0) return { proofPath: null, proofMime: null };
  if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) throw new StockError("Bukti harus JPG, PNG, WEBP, atau PDF");
  if (file.size > MAX_PROOF_BYTES) throw new StockError(MAX_PROOF_TEXT);
  return { proofPath: await saveProof(Buffer.from(await file.arrayBuffer()), file.type), proofMime: file.type };
}

export const saveSale = action(
  "sales.manage",
  async (fd, user) => {
    const items = fd.getAll("itemId").map(String);
    const qty = fd.getAll("qty").map(num);
    const price = fd.getAll("price").map(num);
    const paid = int(fd, "paidAmount");
    const { sale, warnings } = await createSale(
      {
        date: day(fd),
        storeId: str(fd, "storeId"),
        customerId: optStr(fd, "customerId"),
        newCustomerName: optStr(fd, "newCustomerName"),
        newCustomerPhone: optStr(fd, "newCustomerPhone"),
        lines: items.map((itemId, i) => ({ itemId, qty: qty[i], price: price[i] })),
        discount: int(fd, "discount"),
        shipping: int(fd, "shipping"),
        paidNow: paid,
        bankAccountId: paid > 0 ? optStr(fd, "bankAccountId") : null,
        dueDate: optStr(fd, "dueDate") ? day(fd, "dueDate") : null,
        note: optStr(fd, "note"),
        ...(await proofOf(fd)),
      },
      user,
    );
    const rest = Number(sale.total - sale.paid);
    return [`Penjualan ${sale.number} tercatat${rest > 0 ? ` (sisa piutang Rp ${rest.toLocaleString("id-ID")})` : " (lunas)"}`, ...warnings].join(". ");
  },
  PATHS,
);

export const receiveSalePayment = action(
  "sales.manage",
  async (fd, user) => {
    const r = await paySale(str(fd, "id"), { amount: int(fd, "amount"), bankAccountId: str(fd, "bankAccountId"), date: day(fd), note: optStr(fd, "note"), ...(await proofOf(fd)) }, user);
    return r.lunas ? `${r.sale.number} lunas` : `Cicilan ${r.sale.number} dibukukan, sisa Rp ${r.rest.toLocaleString("id-ID")}`;
  },
  PATHS,
);

export const cancelSalePaymentAction = action(
  "sales.manage",
  async (fd, user) => {
    const s = await cancelSalePayment(str(fd, "id"), str(fd, "reason"), user);
    return `Cicilan ${s.number} dibatalkan`;
  },
  PATHS,
);

export const cancelSaleAction = action(
  "sales.manage",
  async (fd, user) => {
    const s = await cancelSale(str(fd, "id"), str(fd, "reason"), user);
    return `Penjualan ${s.number} dibatalkan`;
  },
  PATHS,
);
