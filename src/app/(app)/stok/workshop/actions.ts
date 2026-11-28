"use server";
import { action, str, optStr, dec } from "@/lib/action";
import { cancelWorkshop, recordWorkshop } from "@/lib/produksiWorkshop";
import { ForbiddenError } from "@/lib/auth";
import { jakartaDateTime, todayStr } from "@/lib/time";

/** Simpan produksi workshop: bahan otomatis dari resep, qty aktual (a.<itemId>) boleh diubah */
export const saveWorkshop = action(
  "stock.produce",
  async (fd, user) => {
    const actual: Record<string, number> = {};
    for (const [k, v] of fd.entries()) if (k.startsWith("a.") && typeof v === "string" && v.trim() !== "") actual[k.slice(2)] = Number(v.replace(",", "."));
    const r = await recordWorkshop(
      { outputItemId: str(fd, "itemId"), qty: dec(fd, "qty"), date: jakartaDateTime(str(fd, "date") || todayStr(), "12:00"), note: optStr(fd, "note"), actual },
      user,
    );
    return `Produksi workshop ${r.number} tercatat · nilai hasil Rp ${r.value.toLocaleString("id-ID")} (Rp ${r.unitCost.toLocaleString("id-ID")}/unit)`;
  },
  ["/stok", "/stok/workshop"],
);

export const cancelWorkshopAction = action(
  "stock.approve",
  async (fd, user) => {
    if (user.role !== "OWNER" && !user.can("stock.approve")) throw new ForbiddenError();
    await cancelWorkshop(str(fd, "number"), str(fd, "reason"), user);
    return "Produksi workshop dibatalkan (mutasi & jurnal dibalik)";
  },
  ["/stok", "/stok/workshop"],
);
