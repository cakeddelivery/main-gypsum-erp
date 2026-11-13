"use server";
import { action, int, optStr, str } from "@/lib/action";
import { monthLabel, parseMonth } from "@/lib/budget";
import { MP_FEE_FIELDS, saveMarketplaceMonth, type MpFees } from "@/lib/marketplaceMonthly";

export const saveMarketplaceMonthAction = action(
  "accounting.post",
  async (fd, user) => {
    const { year, month } = parseMonth(str(fd, "month"));
    const fees = Object.fromEntries(MP_FEE_FIELDS.map((f) => [f.key, int(fd, f.key)])) as MpFees;
    const r = await saveMarketplaceMonth({ year, month, bankId: str(fd, "bankId"), storeId: str(fd, "storeId"), fees, gross: str(fd, "gross") ? int(fd, "gross") : null, note: optStr(fd, "note") }, user);
    return `Biaya marketplace ${monthLabel(year, month)} tersimpan: Rp ${r.total.toLocaleString("id-ID")}${r.replaced ? ` (jurnal lama ${r.replaced} dibalik)` : ""}`;
  },
  ["/akuntansi/marketplace", "/akuntansi", "/"],
);
