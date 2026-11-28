import { esc } from "./telegram";
import { cancelRow, can, fmtQty, MENU_TEXT, parseQty, type Ctx, type Prompt, type Session } from "./botKit";
import type { FlowDef } from "./botFlow3";
import { prisma } from "./db";
import { TAKE_DIVISIONS, ambilStok, keringStock, type TakeDivision } from "./ambilStok";

/** Bot: "📥 Ambil stok" — karakter (tombol, tampil stok Oven) → jumlah (tombol cepat atau ketik) → tersimpan (transfer Oven → stok divisi) */
const menuBtn = [{ text: MENU_TEXT, callback_data: "m:home" }];
const PRESETS = [5, 10, 20, 50];

async function ownDivision(userDivisionId: string | null | undefined): Promise<TakeDivision | null> {
  if (!userDivisionId) return null;
  const t = (await prisma.division.findUnique({ where: { id: userDivisionId }, select: { reportTemplate: true } }))?.reportTemplate;
  return t === "ASSEMBLING" || t === "GIFTBOX" ? t : null;
}

export const ambilFlow: FlowDef = {
  async start(ctx: Ctx) {
    if (!can(ctx.i, "stock.take")) return "Anda tidak berwenang mengambil stok";
    const div = await ownDivision((ctx.i.user as { divisionId?: string | null }).divisionId);
    return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "amb", step: div ? "item" : "div", data: div ? { div } : {} } satisfies Session;
  },
  async prompt(s: Session): Promise<Prompt> {
    const d = s.data;
    if (s.step === "div") return { text: "<b>📥 Ambil stok patung kering</b>\n\nUntuk divisi mana?", buttons: [[{ text: "Assembling", callback_data: "f:ASSEMBLING" }, { text: "Giftbox", callback_data: "f:GIFTBOX" }], cancelRow] };
    const div = d.div as TakeDivision;
    const head = `<b>📥 Ambil stok → ${TAKE_DIVISIONS[div].label}</b>${d.itemName ? `\nKarakter: ${esc(String(d.itemName))} (Oven ${fmtQty(Number(d.avail))})` : ""}`;
    if (s.step === "item") {
      const rows = (await keringStock(div)).filter((r) => r.oven > 0);
      return { text: `${head}\n\nKetuk karakter (stok di Oven):`, buttons: [...rows.map((r) => [{ text: `${r.name.replace(/^Patung Kering\s*/i, "")} · ${fmtQty(r.oven)}`.slice(0, 50), callback_data: `f:${r.id}` }]), cancelRow] };
    }
    return { text: `${head}\n\nBerapa yang diambil? Ketuk angka atau ✍️ ketik jumlah.`, buttons: [d.preQty ? [{ text: `✅ Ambil ${fmtQty(Number(d.preQty))}`, callback_data: `f:${d.preQty}` }] : [], PRESETS.filter((q) => q <= Number(d.avail)).map((q) => ({ text: String(q), callback_data: `f:${q}` })), cancelRow].filter((r) => r.length) };
  },
  async answer(ctx, s, v) {
    const d = s.data;
    if (s.step === "div") {
      if (v !== "ASSEMBLING" && v !== "GIFTBOX") return "Pilih Assembling atau Giftbox";
      d.div = v; s.step = "item";
      return null;
    }
    if (s.step === "item") {
      const row = (await keringStock(d.div as TakeDivision)).find((r) => r.id === v);
      if (!row) return "Karakter tidak ditemukan";
      d.itemId = row.id; d.itemName = row.name; d.unit = row.unit; d.avail = row.oven;
      s.step = "qty";
      return null;
    }
    const n = parseQty(v);
    if (n == null || !(n > 0)) return "Ketik jumlah lebih dari 0";
    if (n > Number(d.avail)) return `Stok Oven hanya ${fmtQty(Number(d.avail))}`;
    try {
      const r = await ambilStok({ itemId: String(d.itemId), qty: n, division: d.div as TakeDivision, note: "via Telegram" }, { id: ctx.i.userId, name: ctx.i.user.name });
      d.number = r.number; d.qty = n;
    } catch (e) { return (e as Error).message.slice(0, 200); }
    return "done";
  },
  async finish(_ctx, s) {
    const d = s.data;
    return { text: `✅ <b>Ambil stok ${esc(String(d.number))}</b>\n${esc(String(d.itemName))} × ${fmtQty(Number(d.qty))} ${esc(String(d.unit))} → stok ${TAKE_DIVISIONS[d.div as TakeDivision].label}`, buttons: [[{ text: "📥 Ambil lagi", callback_data: "f:start:amb" }, ...menuBtn]] };
  },
};

/** Ketik bebas "ambil 50 patung kering cewek" → langsung tersimpan lewat alur Ambil stok (jumlah & karakter dikenali); null bila bukan format ini */
export async function ambilFromText(ctx: Ctx, text: string): Promise<Session | null> {
  const m = /^\s*ambil\s+(?:stok\s+)?(\d+(?:[.,]\d+)?)\s*(?:pcs|biji|buah)?\s+(?:patung\s+kering\s+)?(.+?)\s*$/i.exec(text);
  if (!m || !can(ctx.i, "stock.take")) return null;
  const div = await ownDivision((ctx.i.user as { divisionId?: string | null }).divisionId);
  if (!div) return null;
  const qty = parseQty(m[1]);
  const word = m[2].toLowerCase().replace(/^patung\s+kering\s+/, "").trim();
  const rows = (await keringStock(div)).filter((r) => r.name.toLowerCase().includes(word) || r.sku.toLowerCase().endsWith(`-${word}`));
  if (qty == null || !(qty > 0) || rows.length !== 1) return null;
  const r = rows[0];
  return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "amb", step: "qty", data: { div, itemId: r.id, itemName: r.name, unit: r.unit, avail: r.oven, preQty: qty } } satisfies Session;
}
