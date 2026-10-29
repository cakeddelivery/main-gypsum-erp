"use server";
import { action, str, optStr, int } from "@/lib/action";
import { createPurchase } from "@/lib/purchase";
import { jakartaDateTime, todayStr } from "@/lib/time";
import type { PaymentTerm } from "@prisma/client";

export const savePurchase = action(
  "finance.approve",
  async (fd, user) => {
    const items = fd.getAll("itemId").map(String);
    const qty = fd.getAll("qty").map((x) => Number(String(x).replace(",", ".")) || 0);
    const cost = fd.getAll("unitCost").map((x) => Number(String(x).replace(/\./g, "")) || 0);
    const term = str(fd, "term") as PaymentTerm;
    const p = await createPurchase(
      {
        supplierId: optStr(fd, "supplierId"),
        vendor: optStr(fd, "vendor"),
        storeId: str(fd, "storeId"),
        date: jakartaDateTime(str(fd, "date") || todayStr(), "12:00"),
        term,
        lines: items.map((itemId, i) => ({ itemId, qty: qty[i], unitCost: cost[i] })),
        paidNow: term === "BERTAHAP" ? int(fd, "paidNow") : 0,
        bankAccountId: optStr(fd, "bankAccountId"),
        dueDate: optStr(fd, "dueDate") ? jakartaDateTime(str(fd, "dueDate"), "12:00") : null,
        note: optStr(fd, "note"),
      },
      user,
    );
    return `Pembelian ${p.number} tercatat`;
  },
  ["/stok", "/akuntansi/piutang-utang"],
);
