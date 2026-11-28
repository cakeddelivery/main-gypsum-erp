"use server";
import { action, str } from "@/lib/action";
import { ambilStok, cancelAmbil, kembalikanStok, type TakeDivision } from "@/lib/ambilStok";

/** Jumlah dari tombol cepat (qty) atau isian bebas (qtyCustom) */
const qtyOf = (fd: FormData) => Number(String(fd.get("qty") || fd.get("qtyCustom") || "").replace(",", "."));
const div = (fd: FormData): TakeDivision => (str(fd, "division") === "GIFTBOX" ? "GIFTBOX" : "ASSEMBLING");

/** Ambil patung kering dari Oven ke stok divisi (2 ketuk: karakter → jumlah) */
export const saveAmbil = action(
  "stock.take",
  async (fd, user) => {
    const r = await ambilStok({ itemId: str(fd, "itemId"), qty: qtyOf(fd), division: div(fd) }, user);
    return `Ambil stok ${r.number}: ${r.itemName} × ${r.qty} ${r.unit} dari Oven`;
  },
  ["/stok", "/stok/ambil"],
);

export const balikAmbil = action(
  "stock.take",
  async (fd, user) => {
    const r = await kembalikanStok({ itemId: str(fd, "itemId"), qty: qtyOf(fd), division: div(fd) }, user);
    return `Dikembalikan ke Oven ${r.number}: ${r.itemName} × ${r.qty} ${r.unit}`;
  },
  ["/stok", "/stok/ambil"],
);

export const cancelAmbilAction = action(
  "stock.approve",
  async (fd, user) => {
    await cancelAmbil(str(fd, "number"), str(fd, "reason"), user);
    return "Ambil stok dibatalkan (mutasi dibalik)";
  },
  ["/stok", "/stok/ambil"],
);
