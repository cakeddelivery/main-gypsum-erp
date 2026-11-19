"use server";
import { action, int, optStr, str } from "@/lib/action";
import { createInvoice, invoiceFromSale, voidInvoice } from "@/lib/invoice";
import { redirect } from "next/navigation";

export const createInvoiceAction = action(
  "sales.manage",
  async (fd, user) => {
    const ids = fd.getAll("itemId").map(String);
    const qtys = fd.getAll("qty").map(String);
    const prices = fd.getAll("price").map(String);
    const lines = ids.map((itemId, i) => ({ itemId, qty: Number(qtys[i]?.replace(",", ".")) || 0, price: Number((prices[i] ?? "").replace(/\./g, "").replace(",", ".")) || 0 })).filter((l) => l.itemId);
    const inv = await createInvoice(user, {
      storeId: str(fd, "storeId"), channel: str(fd, "channel"), date: str(fd, "date"), customerName: str(fd, "customerName"), lines,
      discount: int(fd, "discount"), shipping: int(fd, "shipping"), paid: str(fd, "paid") === "1" ? Number.MAX_SAFE_INTEGER : 0, note: optStr(fd, "note"),
    });
    redirect(`/penjualan/invoice/${inv.id}`);
  },
  ["/penjualan"],
);

/** Buat (atau buka) invoice dari penjualan offline */
export const invoiceFromSaleAction = action(
  "sales.manage",
  async (fd, user) => {
    const inv = await invoiceFromSale(user, str(fd, "saleId"));
    redirect(`/penjualan/invoice/${inv.id}`);
  },
  ["/penjualan"],
);

export const voidInvoiceAction = action(
  "sales.manage",
  async (fd, user) => {
    await voidInvoice(user, str(fd, "id"), str(fd, "reason"));
    return "Invoice dibatalkan";
  },
  ["/penjualan"],
);
