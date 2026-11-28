import { esc } from "./telegram";
import { cancelRow, can, fmtQty, MENU_TEXT, parseQty, type Ctx, type Prompt, type Session } from "./botKit";
import type { FlowDef } from "./botFlow3";
import { workshopItems } from "./produksiWorkshop";
import { bongkarPlan, bongkarRetur } from "./bongkarRetur";
import { prisma } from "./db";
import { idr } from "./money";

/** Bot: "🔧 Bongkar retur" — pilih barang retur (tombol) → jumlah → tandai RUSAK per komponen (tombol "Tidak ada" / ketik jumlah) → simpan */
const menuBtn = [{ text: MENU_TEXT, callback_data: "m:home" }];
type Line = { itemId: string; name: string; unit: string; total: number };

export const bongkarFlow: FlowDef = {
  async start(ctx: Ctx) {
    if (!can(ctx.i, "stock.produce") && !can(ctx.i, "retur.manage")) return "Anda tidak berwenang membongkar retur";
    return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "brt", step: "item", data: {} } satisfies Session;
  },
  async prompt(s: Session): Promise<Prompt> {
    const d = s.data;
    const lines = JSON.parse(String(d.lines ?? "[]")) as Line[];
    const head = ["<b>🔧 Bongkar retur</b>", d.itemName ? `Barang: ${esc(String(d.itemName))}${d.qty ? ` × ${fmtQty(Number(d.qty))} ${esc(String(d.unit))}` : ""}` : ""].filter(Boolean).join("\n");
    if (s.step === "item") {
      const q = String(d.q ?? "").trim().toLowerCase();
      const items = (await workshopItems()).filter((i) => !q || i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q)).slice(0, 12);
      return { text: `${head}\n\nPilih barang retur yang dibongkar, atau ✍️ ketik nama untuk mencari:`, buttons: [...items.map((i) => [{ text: `${i.name} (${i.unit})`.slice(0, 50), callback_data: `f:${i.id}` }]), cancelRow] };
    }
    if (s.step === "qty") return { text: `${head}\n\n✍️ Ketik jumlah yang dibongkar (${esc(String(d.unit))})`, buttons: [cancelRow] };
    if (s.step === "rusak") {
      const idx = Number(d.idx ?? 0);
      const l = lines[idx];
      return { text: `${head}\n\nKomponen ${idx + 1}/${lines.length}: <b>${esc(l.name)}</b> (isi ${fmtQty(l.total)} ${esc(l.unit)})\nBerapa yang RUSAK? Ketik jumlah, atau tekan tombol.`, buttons: [[{ text: "✅ Tidak ada rusak", callback_data: "f:0" }, { text: "Semua rusak", callback_data: `f:all` }], cancelRow] };
    }
    const bad = Object.entries(JSON.parse(String(d.damaged ?? "{}")) as Record<string, number>).filter(([, q]) => q > 0).map(([id, q]) => `• ${esc(lines.find((l) => l.itemId === id)?.name ?? "")}: ${fmtQty(q)} rusak`);
    return { text: `${head}\n\n${bad.length ? `Rusak (jadi reject):\n${bad.join("\n")}` : "Semua komponen layak."}\n\nSimpan? Komponen layak masuk stok; rusak dicatat sebagai reject.`, buttons: [[{ text: "✅ Simpan", callback_data: "f:ok" }], cancelRow] };
  },
  async answer(ctx, s, v, fromText) {
    const d = s.data;
    if (s.step === "item") {
      if (fromText) { d.q = v.slice(0, 40); return null; }
      const it = (await workshopItems()).find((x) => x.id === v);
      if (!it) return "Barang tidak ditemukan";
      d.itemId = it.id; d.itemName = it.name; d.unit = it.unit; d.q = null;
      s.step = "qty";
      return null;
    }
    if (s.step === "qty") {
      const n = parseQty(v);
      if (n == null || !(n > 0)) return "Ketik jumlah lebih dari 0";
      try {
        const plan = await bongkarPlan(prisma, String(d.itemId), n);
        d.lines = JSON.stringify(plan.lines.map((l) => ({ itemId: l.itemId, name: l.name, unit: l.unit, total: l.total })));
      } catch (e) { return (e as Error).message.slice(0, 200); }
      d.qty = n; d.idx = 0; d.damaged = "{}";
      s.step = "rusak";
      return null;
    }
    if (s.step === "rusak") {
      const lines = JSON.parse(String(d.lines)) as Line[];
      const l = lines[Number(d.idx)];
      const n = v === "all" ? l.total : v === "0" ? 0 : parseQty(v);
      if (n == null || n < 0 || n > l.total) return `Isi 0 sampai ${fmtQty(l.total)}`;
      const dm = JSON.parse(String(d.damaged)) as Record<string, number>;
      dm[l.itemId] = n;
      d.damaged = JSON.stringify(dm);
      d.idx = Number(d.idx) + 1;
      if (Number(d.idx) >= lines.length) s.step = "confirm";
      return null;
    }
    if (v !== "ok") return "Tekan Simpan atau Batal";
    try {
      const r = await bongkarRetur({ itemId: String(d.itemId), qty: Number(d.qty), damaged: JSON.parse(String(d.damaged)) as Record<string, number>, note: "via Telegram" }, { id: ctx.i.userId, name: ctx.i.user.name });
      d.number = r.number; d.good = r.goodValue; d.reject = r.rejectValue;
    } catch (e) { return (e as Error).message.slice(0, 200); }
    return "done";
  },
  async finish(_ctx, s) {
    const d = s.data;
    return { text: `✅ <b>Bongkar retur ${esc(String(d.number))} tercatat</b>\n${esc(String(d.itemName))} × ${fmtQty(Number(d.qty))} · komponen layak ${idr(Number(d.good))}${Number(d.reject) ? ` · reject ${idr(Number(d.reject))}` : ""}`, buttons: [[{ text: "🔧 Bongkar lagi", callback_data: "f:start:brt" }, ...menuBtn]] };
  },
};
