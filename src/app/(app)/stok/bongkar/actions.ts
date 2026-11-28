"use server";
import { action, str, optStr, dec } from "@/lib/action";
import { bongkarRetur, cancelBongkar } from "@/lib/bongkarRetur";
import { jakartaDateTime, todayStr } from "@/lib/time";

/** Simpan bongkar retur: jumlah RUSAK per komponen (d.<itemId>), default 0 */
export const saveBongkar = action(
  "stock.produce",
  async (fd, user) => {
    const damaged: Record<string, number> = {};
    for (const [k, v] of fd.entries()) if (k.startsWith("d.") && typeof v === "string" && v.trim() !== "") damaged[k.slice(2)] = Number(v.replace(",", "."));
    const r = await bongkarRetur({ itemId: str(fd, "itemId"), qty: dec(fd, "qty"), damaged, reason: optStr(fd, "reason") ?? undefined, returnNumber: optStr(fd, "returnNumber"), date: jakartaDateTime(str(fd, "date") || todayStr(), "12:00"), note: optStr(fd, "note") }, user);
    return `Bongkar retur ${r.number} tercatat · komponen layak Rp ${r.goodValue.toLocaleString("id-ID")}${r.rejectValue ? ` · reject Rp ${r.rejectValue.toLocaleString("id-ID")}` : ""}`;
  },
  ["/stok", "/stok/bongkar"],
);

export const cancelBongkarAction = action(
  "stock.approve",
  async (fd, user) => {
    await cancelBongkar(str(fd, "number"), str(fd, "reason"), user);
    return "Bongkar retur dibatalkan (mutasi & jurnal dibalik)";
  },
  ["/stok", "/stok/bongkar"],
);
