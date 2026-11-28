import { esc } from "./telegram";
import { chunk, cancelRow, can, fmtQty, MENU_TEXT, parseQty, type Ctx, type Prompt, type Session } from "./botKit";
import type { FlowDef } from "./botFlow3";
import { prisma } from "./db";
import { recordWorkshop, workshopItems, workshopPlan } from "./produksiWorkshop";
import { idr } from "./money";

/** Bot: "🏭 Produksi workshop" — pilih hasil (tombol) → jumlah → bahan otomatis dari resep → simpan (fungsi posting yang sama dengan web) */
const menuBtn = [{ text: MENU_TEXT, callback_data: "m:home" }];

export const workshopFlow: FlowDef = {
  async start(ctx: Ctx) {
    if (!can(ctx.i, "stock.produce")) return "Anda tidak berwenang mencatat produksi workshop";
    return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "wsp", step: "item", data: {} } satisfies Session;
  },
  async prompt(s: Session): Promise<Prompt> {
    const d = s.data;
    const head = ["<b>🏭 Produksi workshop</b>", d.itemName ? `Hasil: ${esc(String(d.itemName))}${d.qty ? ` × ${fmtQty(Number(d.qty))} ${esc(String(d.unit))}` : ""}` : ""].filter(Boolean).join("\n");
    if (s.step === "item") {
      const q = String(d.q ?? "").trim().toLowerCase();
      const items = (await workshopItems()).filter((i) => !q || i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q)).slice(0, 12);
      return { text: `${head}\n\nPilih hasil produksi${q ? ` (filter "${esc(q)}")` : ""}, atau ✍️ ketik nama untuk mencari:`, buttons: [...items.map((i) => [{ text: `${i.name} (${i.unit})`.slice(0, 50), callback_data: `f:${i.id}` }]), cancelRow] };
    }
    if (s.step === "qty") return { text: `${head}\n\n✍️ Ketik jumlah hasil (${esc(String(d.unit))}), contoh <code>50</code>`, buttons: [cancelRow] };
    const plan = await workshopPlan(prisma, String(d.itemId), Number(d.qty));
    const lines = plan.lines.map((l) => `• ${esc(l.name)}: ${fmtQty(l.planned)} ${esc(l.unit)}${l.available < l.planned ? ` ⚠ stok ${fmtQty(l.available)}` : ""}`).join("\n");
    return { text: `${head}\n\nBahan otomatis dari resep:\n${lines}\n\nSimpan? Bahan dikurangi dari stok, hasil masuk setengah jadi (tanpa upah borongan).`, buttons: [[{ text: "✅ Simpan", callback_data: "f:ok" }], cancelRow] };
  },
  async answer(_ctx, s, v, fromText) {
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
      d.qty = n;
      s.step = "confirm";
      return null;
    }
    if (v !== "ok") return "Tekan Simpan atau Batal";
    try {
      const r = await recordWorkshop({ outputItemId: String(d.itemId), qty: Number(d.qty), note: "via Telegram" }, { id: _ctx.i.userId, name: _ctx.i.user.name });
      d.number = r.number; d.value = r.value;
    } catch (e) {
      return (e as Error).message.slice(0, 200);
    }
    return "done";
  },
  async finish(_ctx, s) {
    const d = s.data;
    return { text: `✅ <b>Produksi workshop ${esc(String(d.number))} tercatat</b>\n${esc(String(d.itemName))} × ${fmtQty(Number(d.qty))} ${esc(String(d.unit))} · nilai ${idr(Number(d.value))}\nStok bahan sudah berkurang, hasil masuk setengah jadi.`, buttons: [[{ text: "🏭 Produksi lagi", callback_data: "f:start:wsp" }, ...menuBtn]] };
  },
};
