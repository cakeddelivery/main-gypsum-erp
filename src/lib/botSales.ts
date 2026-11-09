import { prisma } from "./db";
import { createSale, offlinePrices, paySale, saleTotals, WALK_IN } from "./sales";
import { StockError } from "./stock";
import { saveProof } from "./storage";
import { renderDocJpg, RenderError } from "./render";
import { idr, parseIDR } from "./money";
import { addDays, dateOnly, dayRange, fmtDate, jakartaDateTime, todayStr } from "./time";
import { chatAction, esc, sendTelegram, sendTelegramDocument, type InlineButton } from "./telegram";
import { cancelRow, can, chunk, fmtQty, MENU_TEXT, PAGE, pager, parseQty, type Ctx, type Prompt, type Session } from "./botKit";
import type { BotIdent } from "./botMenu";
import type { FlowDef } from "./botFlow3";
import { guardDup } from "./botDup";

/**
 * Penjualan offline lewat bot Telegram: catat nota (toko, pelanggan, barang, diskon, ongkir, pembayaran),
 * kirim nota JPG, dan terima cicilan piutang penjualan. Simpan memanggil createSale / paySale yang sama
 * dengan menu Penjualan di web, jadi jurnal, stok barang jadi, HPP, dan piutangnya identik.
 */

type Line = { itemId: string; name: string; unit: string; qty: number; price: number };
const getLines = (s: Session): Line[] => JSON.parse(String(s.data.lines ?? "[]"));
const setLines = (s: Session, l: Line[]) => void (s.data.lines = JSON.stringify(l));
const linesText = (l: Line[]) => l.map((x, k) => `${k + 1}. ${esc(x.name)}: ${fmtQty(x.qty)} ${esc(x.unit)} × ${idr(x.price)} = ${idr(Math.round(x.qty * x.price))}`).join("\n");
const menuBtn: InlineButton[] = [{ text: MENU_TEXT, callback_data: "m:home" }];
const actorOf = (i: BotIdent) => ({ id: i.userId, name: i.user.name });
const errMsg = (e: unknown) => (e instanceof StockError ? e.message : (e as Error).message.slice(0, 200));
const PAY_LABEL: Record<string, string> = { L: "Lunas", S: "Bayar sebagian", T: "Tempo (belum bayar)" };
const HEAD = "<b>🛒 Penjualan</b>";

export function salesMenuRows(i: BotIdent): InlineButton[][] {
  return can(i, "sales.manage") ? [[{ text: "🛒 Penjualan", callback_data: "f:start:jual" }]] : [];
}

const banks = () => prisma.bankAccount.findMany({ where: { active: true, marketplace: false }, orderBy: { code: "asc" } });
const bankButtons = async () => chunk((await banks()).map((b) => ({ text: b.name, callback_data: `f:${b.id}` })), 2);
const dueButtons: InlineButton[][] = [[{ text: "7 hari", callback_data: "f:7" }, { text: "14 hari", callback_data: "f:14" }, { text: "30 hari", callback_data: "f:30" }]];

/** Tanggal jatuh tempo dari tombol (jumlah hari) atau ketikan: 25/11, 25/11/2026, 2026-11-25 */
export function parseDue(v: string, today = todayStr()): string | null {
  const t = v.trim();
  if (/^\d{1,3}$/.test(t)) return Number(t) > 0 ? addDays(today, Number(t)) : null;
  let y = Number(today.slice(0, 4)),
    m: number,
    d: number;
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const idn = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (idn) {
    [d, m] = [Number(idn[1]), Number(idn[2])];
    if (idn[3]) y = idn[3].length === 2 ? 2000 + Number(idn[3]) : Number(idn[3]);
    else if (`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` < today) y++;
  } else return null;
  const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dt = new Date(`${s}T00:00:00Z`);
  if (isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== s) return null;
  return s >= today ? s : null;
}

/** Harga jual saran: harga offline terakhir di Produk & HPP, bila tidak ada harga jual terakhir barang itu */
async function suggestPrice(itemId: string): Promise<number | null> {
  const p = (await offlinePrices()).get(itemId);
  if (p) return p;
  const last = await prisma.saleLine.findFirst({ where: { itemId, sale: { cancelledAt: null } }, orderBy: { sale: { date: "desc" } }, select: { price: true } });
  return last ? Number(last.price) : null;
}

/** Kirim nota penjualan JPG (dokumen DocSheet "nota" yang sama dengan Unduh JPG di web) */
export async function sendSaleNota(i: BotIdent, chatId: string, saleId: string) {
  const s = await prisma.sale.findUnique({ where: { id: saleId } });
  if (!s) return sendTelegram(chatId, "Nota tidak ditemukan.");
  try {
    await chatAction(chatId, "upload_document").catch(() => {});
    const jpg = await renderDocJpg(i.userId, `/penjualan/${s.id}`, "nota");
    const rest = Number(s.total - s.paid);
    const r = await sendTelegramDocument(chatId, jpg, `nota-${s.number}.jpg`, `Nota ${s.number} · ${s.customerName} · ${idr(s.total)}${rest > 0 ? ` · sisa ${idr(rest)}` : " · lunas"}`, { type: "NOTA_JPG" });
    if (!r.ok) await sendTelegram(chatId, `Gagal mengirim nota JPG: ${esc(r.error ?? "")}`);
  } catch (e) {
    const msg = e instanceof RenderError ? e.message : "terjadi kesalahan saat membuat JPG";
    await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "NOTA_JPG", target: chatId, status: "GAGAL", payload: s.number, error: (e as Error).message.slice(0, 500) } });
    await sendTelegram(chatId, `❌ Nota JPG belum bisa dibuat: ${esc(msg)}. Unduh dari menu Penjualan di website.`);
  }
}

/** Nota yang masih punya sisa tagihan (belum dibatalkan), jatuh tempo terdekat dulu */
function openSales(skip = 0, take = PAGE + 1) {
  return prisma.sale.findMany({ where: { cancelledAt: null, paid: { lt: prisma.sale.fields.total } }, orderBy: [{ dueDate: "asc" }, { number: "asc" }], skip, take });
}

// =====================================================================
// Menu Penjualan
// =====================================================================
const salesMenu: FlowDef = {
  async start(ctx) {
    if (!can(ctx.i, "sales.manage")) return "Anda tidak berwenang mencatat penjualan";
    const open = await openSales(0, 1000);
    const left = open.reduce((t, s) => t + Number(s.total - s.paid), 0);
    const late = open.filter((s) => s.dueDate && s.dueDate < dayRange(todayStr()).end).length;
    return {
      text: `${HEAD}\n${open.length ? `Piutang penjualan: <b>${idr(left)}</b> dari ${open.length} nota${late ? ` · ⚠️ ${late} jatuh tempo` : ""}` : "Tidak ada piutang penjualan. ✅"}\n\nPilih menu:`,
      buttons: [[{ text: "➕ Catat penjualan", callback_data: "f:start:jnew" }], ...(open.length ? [[{ text: "💰 Terima cicilan piutang", callback_data: "f:start:jcil" }]] : []), menuBtn],
    };
  },
  prompt: async () => ({ text: "" }),
  answer: async () => null,
  finish: async () => ({ text: "" }),
};

// =====================================================================
// Catat penjualan
// =====================================================================
function totalsOf(s: Session) {
  const d = s.data;
  const lines = getLines(s);
  const subtotal = lines.reduce((t, l) => t + Math.round(l.qty * l.price), 0);
  const total = subtotal - Number(d.discount ?? 0) + Number(d.shipping ?? 0);
  return { lines, subtotal, total };
}

const newSale: FlowDef = {
  async start(ctx) {
    if (!can(ctx.i, "sales.manage")) return "Anda tidak berwenang mencatat penjualan";
    const stores = await prisma.store.findMany({ where: { active: true }, orderBy: { code: "asc" } });
    if (!stores.length) return "Belum ada toko aktif";
    const one = stores.length === 1 ? stores[0] : null;
    return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "jnew", step: one ? "cust" : "store", data: { page: 0, lines: "[]", storeId: one?.id ?? null, storeName: one?.name ?? null } };
  },
  async prompt(s) {
    const d = s.data;
    const { lines, subtotal, total } = totalsOf(s);
    const head = [
      HEAD,
      d.storeName ? `Toko: ${esc(String(d.storeName))}` : "",
      d.custName ? `Pelanggan: ${esc(String(d.custName))}${d.custNew ? " (baru)" : ""}` : "",
      lines.length ? `${linesText(lines)}\nJumlah: ${idr(subtotal)}` : "",
      d.itemName && ["qty", "price"].includes(s.step) ? `Barang: ${esc(String(d.itemName))}${d.qty ? ` · ${fmtQty(Number(d.qty))} ${esc(String(d.unit))}` : ""}` : "",
      d.discount != null && Number(d.discount) > 0 ? `Diskon: ${idr(Number(d.discount))}` : "",
      d.shipping != null && Number(d.shipping) > 0 ? `Ongkir: ${idr(Number(d.shipping))}` : "",
      d.shipping != null ? `Tagihan: <b>${idr(total)}</b>` : "",
      d.mode ? `Pembayaran: ${PAY_LABEL[String(d.mode)]}${d.mode === "S" && d.paid != null ? ` ${idr(Number(d.paid))} · sisa piutang ${idr(total - Number(d.paid))}` : ""}` : "",
      d.bankName ? `Ke rekening: ${esc(String(d.bankName))}` : "",
      d.due ? `Jatuh tempo: ${fmtDate(dateOnly(String(d.due)))}` : "",
      d.note ? `Catatan: ${esc(String(d.note))}` : "",
    ].filter(Boolean).join("\n");
    const page = Number(d.page ?? 0);
    switch (s.step) {
      case "store": {
        const stores = await prisma.store.findMany({ where: { active: true }, orderBy: { code: "asc" } });
        return { text: `${head}\nPilih toko:`, buttons: [...chunk(stores.map((x) => ({ text: `${x.code} · ${x.name}`.slice(0, 40), callback_data: `f:${x.id}` })), 2), cancelRow] };
      }
      case "cust": {
        const cs = await prisma.customer.findMany({ where: { active: true }, orderBy: { name: "asc" }, skip: page * PAGE, take: PAGE + 1 });
        return {
          text: `${head}\nPilih pelanggan, atau ✍️ ketik nama untuk mencari / menambah pelanggan baru:`,
          buttons: [[{ text: `👤 ${WALK_IN}`, callback_data: "f:walk" }], ...chunk(cs.slice(0, PAGE).map((c) => ({ text: c.name.slice(0, 30), callback_data: `f:${c.id}` })), 2), ...pager(page, cs.length > PAGE), cancelRow],
        };
      }
      case "item": {
        const its = await prisma.item.findMany({ where: { active: true, type: "BARANG_JADI" }, orderBy: { name: "asc" }, skip: page * PAGE, take: PAGE + 1 });
        return {
          text: `${head}\n\nPilih produk, atau ✍️ ketik nama/kode produk untuk mencari:`,
          buttons: [...chunk(its.slice(0, PAGE).map((x) => ({ text: x.name.slice(0, 30), callback_data: `f:${x.id}` })), 2), ...pager(page, its.length > PAGE), ...(lines.length ? [[{ text: "Selesai ➡", callback_data: "f:done" }]] : []), cancelRow],
        };
      }
      case "qty":
        return { text: `${head}\n\n✍️ Ketik jumlah dalam <b>${esc(String(d.unit))}</b>, contoh <code>10</code>`, buttons: [cancelRow] };
      case "price":
        return {
          text: `${head}\n\n${d.sugg ? `Harga jual: <b>${idr(Number(d.sugg))}</b>/${esc(String(d.unit))} (harga offline terakhir). Pakai harga ini atau ✍️ ketik harga lain per ${esc(String(d.unit))}.` : `✍️ Ketik harga jual per ${esc(String(d.unit))}, contoh <code>15000</code> atau <code>15rb</code>.`}`,
          buttons: [...(d.sugg ? [[{ text: `✅ Pakai ${idr(Number(d.sugg))}`, callback_data: "f:keep" }]] : []), cancelRow],
        };
      case "more":
        return { text: `${head}\n\nAda barang lain di nota ini?`, buttons: [[{ text: "➕ Tambah barang", callback_data: "f:add" }, { text: "Selesai ➡", callback_data: "f:done" }], [{ text: "🗑 Hapus barang terakhir", callback_data: "f:undo" }], cancelRow] };
      case "disc":
        return { text: `${head}\n\n✍️ Ketik diskon untuk nota ini (Rp), atau tanpa diskon.`, buttons: [[{ text: "Tanpa diskon", callback_data: "f:0" }], cancelRow] };
      case "ship":
        return { text: `${head}\n\n✍️ Ketik ongkir yang ditagih ke pembeli (Rp), atau tanpa ongkir.`, buttons: [[{ text: "Tanpa ongkir", callback_data: "f:0" }], cancelRow] };
      case "mode":
        return { text: `${head}\n\nPembayaran:`, buttons: [[{ text: `💵 Lunas (${idr(total)})`, callback_data: "f:L" }], [{ text: "Bayar sebagian", callback_data: "f:S" }, { text: "Tempo", callback_data: "f:T" }], cancelRow] };
      case "paid":
        return { text: `${head}\n\n✍️ Ketik nominal yang dibayar sekarang (kurang dari ${idr(total)}).`, buttons: [cancelRow] };
      case "bank":
        return { text: `${head}\nDibayar ke rekening:`, buttons: [...(await bankButtons()), cancelRow] };
      case "due":
        return { text: `${head}\nJatuh tempo sisa tagihan, pilih atau ✍️ ketik tanggal (contoh <code>25/11</code>):`, buttons: [...dueButtons, cancelRow] };
      case "note":
        return { text: `${head}\n\n✍️ Ketik catatan, atau lewati.`, buttons: [[{ text: "Lewati", callback_data: "f:skip" }], cancelRow] };
      case "confirm":
        return {
          text: `${head}\n\nSimpan penjualan ini? Stok barang jadi keluar dan jurnal langsung tercatat.`,
          buttons: [[{ text: "✅ Simpan", callback_data: "f:ok" }, { text: "➕ Tambah barang", callback_data: "f:add" }], [{ text: "❌ Batal", callback_data: "f:x" }]],
        };
    }
    return { text: head };
  },
  async answer(ctx, s, v, fromText) {
    const d = s.data;
    const { lines, subtotal, total } = totalsOf(s);
    switch (s.step) {
      case "store": {
        const st = fromText ? null : await prisma.store.findUnique({ where: { id: v } });
        if (!st) return "Pilih toko dengan tombol";
        d.storeId = st.id;
        d.storeName = st.name;
        d.page = 0;
        s.step = "cust";
        return null;
      }
      case "cust": {
        if (fromText) {
          const name = v.trim().replace(/\s+/g, " ").slice(0, 80);
          if (name.length < 2) return "Nama pelanggan minimal 2 huruf";
          const found = await prisma.customer.findMany({ where: { active: true, name: { contains: name, mode: "insensitive" } }, orderBy: { name: "asc" }, take: 8 });
          d.q = name;
          const same = found.some((c) => c.name.toLowerCase() === name.toLowerCase());
          return {
            text: `${HEAD}\n${found.length ? `Pelanggan yang cocok dengan "${esc(name)}":` : `Belum ada pelanggan bernama "${esc(name)}".`}`,
            buttons: [...found.map((c) => [{ text: `${c.name}${c.phone ? ` · ${c.phone}` : ""}`.slice(0, 50), callback_data: `f:${c.id}` }]), ...(same ? [] : [[{ text: `➕ Tambah pelanggan baru "${name}"`.slice(0, 60), callback_data: "f:new" }]]), [{ text: "🔎 Cari lagi", callback_data: "f:again" }], cancelRow],
          };
        }
        if (v === "again") return null;
        if (v === "walk") {
          d.custId = null;
          d.custName = WALK_IN;
          d.custNew = 0;
        } else if (v === "new") {
          if (!d.q) return "Ketik nama pelanggan baru";
          d.custId = null;
          d.custName = String(d.q);
          d.custNew = 1;
        } else {
          const c = await prisma.customer.findUnique({ where: { id: v } });
          if (!c) return "Pelanggan tidak ditemukan";
          d.custId = c.id;
          d.custName = c.name;
          d.custNew = 0;
        }
        d.q = null;
        d.page = 0;
        s.step = !lines.length ? "item" : d.mode ? "confirm" : d.shipping != null ? "mode" : "more";
        return null;
      }
      case "item": {
        if (fromText) {
          const q = v.trim();
          if (q.length < 2) return "Ketik minimal 2 huruf nama produk";
          const its = await prisma.item.findMany({ where: { active: true, type: "BARANG_JADI", OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }] }, orderBy: { name: "asc" }, take: 10 });
          if (!its.length) return `Tidak ada produk yang cocok dengan "${q.slice(0, 30)}". Ketik nama lain.`;
          return { text: `${HEAD}\nHasil pencarian "${esc(q.slice(0, 30))}":`, buttons: [...its.map((x) => [{ text: `${x.name} (${x.unit})`.slice(0, 50), callback_data: `f:${x.id}` }]), [{ text: "🔎 Daftar produk", callback_data: "f:again" }], cancelRow] };
        }
        if (v === "again") return null;
        if (v === "done") {
          if (!lines.length) return "Isi minimal satu barang";
          s.step = "disc";
          return null;
        }
        const it = await prisma.item.findUnique({ where: { id: v } });
        if (!it || it.type !== "BARANG_JADI") return "Produk tidak ditemukan";
        d.itemId = it.id;
        d.itemName = it.name;
        d.unit = it.unit;
        d.qty = null;
        d.sugg = await suggestPrice(it.id);
        s.step = "qty";
        return null;
      }
      case "qty": {
        const n = parseQty(v);
        if (n == null || !(n > 0)) return "Ketik jumlah lebih dari 0";
        d.qty = n;
        s.step = "price";
        return null;
      }
      case "price": {
        const n = !fromText && v === "keep" ? Number(d.sugg) : parseIDR(v);
        if (n == null || !(n > 0)) return "Ketik harga jual, contoh 15000 atau 15rb";
        lines.push({ itemId: String(d.itemId), name: String(d.itemName), unit: String(d.unit), qty: Number(d.qty), price: n });
        setLines(s, lines);
        d.itemId = d.itemName = d.qty = d.sugg = null;
        // Tagihan berubah: pembayaran ditanyakan ulang
        d.mode = d.paid = d.bankId = d.bankName = d.due = null;
        d.page = 0;
        s.step = "more";
        return null;
      }
      case "more":
        if (fromText) return "Pilih dengan tombol";
        if (v === "undo") {
          lines.pop();
          setLines(s, lines);
          s.step = lines.length ? "more" : "item";
          return null;
        }
        s.step = v === "add" ? "item" : "disc";
        return null;
      case "disc": {
        const n = !fromText ? 0 : parseIDR(v);
        if (n == null || n < 0) return "Ketik diskon, contoh 5000 atau 5rb";
        if (n > subtotal) return `Diskon melebihi jumlah harga barang (${idr(subtotal)})`;
        d.discount = n;
        s.step = "ship";
        return null;
      }
      case "ship": {
        const n = !fromText ? 0 : parseIDR(v);
        if (n == null || n < 0) return "Ketik ongkir, contoh 10000 atau 10rb";
        d.shipping = n;
        s.step = "mode";
        return null;
      }
      case "mode": {
        if (fromText || !PAY_LABEL[v]) return "Pilih pembayaran dengan tombol";
        if (v !== "L" && !d.custId && !d.custNew) {
          d.page = 0;
          s.step = "cust";
          return "Penjualan tempo / bayar sebagian wajib memilih pelanggan. Pilih pelanggan dulu.";
        }
        d.mode = v;
        d.paid = v === "L" ? total : v === "T" ? 0 : null;
        s.step = v === "S" ? "paid" : v === "L" ? "bank" : "due";
        return null;
      }
      case "paid": {
        const n = parseIDR(v);
        if (n == null || !(n > 0) || n >= total) return `Nominal harus lebih dari 0 dan kurang dari ${idr(total)}`;
        d.paid = n;
        s.step = "bank";
        return null;
      }
      case "bank": {
        const b = fromText ? null : await prisma.bankAccount.findUnique({ where: { id: v } });
        if (!b) return "Pilih rekening dengan tombol";
        d.bankId = b.id;
        d.bankName = b.name;
        s.step = d.mode === "S" ? "due" : "note";
        return null;
      }
      case "due": {
        const due = parseDue(v);
        if (!due) return "Pilih jatuh tempo dengan tombol, atau ketik tanggal hari ini/sesudahnya, contoh 25/11";
        d.due = due;
        s.step = "note";
        return null;
      }
      case "note":
        d.note = fromText ? v.slice(0, 200) : null;
        s.step = "confirm";
        return null;
      case "confirm": {
        if (v === "add") {
          s.step = "item";
          return null;
        }
        if (v !== "ok") return "Tekan Simpan atau Batal";
        if (!can(ctx.i, "sales.manage")) return "Anda tidak berwenang";
        if (!d.mode) {
          s.step = "disc";
          return "Lengkapi diskon, ongkir, dan pembayaran dulu";
        }
        if (Number(d.paid ?? 0) > 0 && (await guardDup(s, v, { direction: "MASUK", amount: Number(d.paid), date: new Date(), accountId: d.bankId ? String(d.bankId) : null, text: `penjualan ${d.custName ?? ""}` }))) return null;
        try {
          saleTotals(lines, Number(d.discount ?? 0), Number(d.shipping ?? 0), Number(d.paid ?? 0));
          const paid = Number(d.paid ?? 0);
          const { sale, warnings } = await createSale(
            {
              date: jakartaDateTime(todayStr(), "12:00"),
              storeId: String(d.storeId),
              customerId: d.custId ? String(d.custId) : null,
              newCustomerName: !d.custId && d.custNew ? String(d.custName) : null,
              lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, price: l.price })),
              discount: Number(d.discount ?? 0),
              shipping: Number(d.shipping ?? 0),
              paidNow: paid,
              bankAccountId: paid > 0 ? String(d.bankId) : null,
              dueDate: paid < total && d.due ? jakartaDateTime(String(d.due), "12:00") : null,
              note: [d.note ? String(d.note) : "", "via Telegram"].filter(Boolean).join(" · "),
            },
            actorOf(ctx.i),
          );
          d.saleId = sale.id;
          d.number = sale.number;
          d.total = Number(sale.total);
          d.rest = Number(sale.total - sale.paid);
          d.warn = warnings.join("\n") || null;
        } catch (e) {
          return errMsg(e);
        }
        return "done";
      }
    }
    return null;
  },
  async finish(ctx, s) {
    const d = s.data;
    // Nota JPG dikirim di bawah pesan ini (pesan konfirmasi diubah menjadi ringkasan tersimpan)
    if (d.saleId) await sendSaleNota(ctx.i, ctx.chatId, String(d.saleId));
    return {
      text: [
        `✅ <b>Penjualan ${esc(String(d.number))} tercatat</b>${Number(d.rest) > 0 ? "" : " (lunas)"}`,
        `${esc(String(d.custName))} · ${esc(String(d.storeName))}`,
        linesText(getLines(s)),
        `Tagihan: <b>${idr(Number(d.total))}</b>${Number(d.rest) > 0 ? ` · sisa piutang ${idr(Number(d.rest))}${d.due ? ` (jatuh tempo ${fmtDate(dateOnly(String(d.due)))})` : ""}` : ""}`,
        d.warn ? `\n⚠️ ${esc(String(d.warn))}` : "",
      ].filter(Boolean).join("\n"),
      buttons: [[{ text: "➕ Penjualan lain", callback_data: "f:start:jnew" }, ...menuBtn]],
    };
  },
};

// =====================================================================
// Terima cicilan piutang penjualan
// =====================================================================
/** Foto bukti dikirim saat isian cicilan menunggu bukti: simpan, lanjut konfirmasi */
export async function salePaymentPhoto(s: Session, photo: Buffer) {
  s.data.proofPath = await saveProof(photo, "image/jpeg");
  s.step = "confirm";
  return s;
}

const salePayment: FlowDef = {
  async start(ctx) {
    if (!can(ctx.i, "sales.manage")) return "Anda tidak berwenang menerima cicilan penjualan";
    if (!(await openSales(0, 1)).length) return "✅ Tidak ada piutang penjualan yang belum lunas.";
    return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "jcil", step: "sale", data: { page: 0 } };
  },
  async prompt(s) {
    const d = s.data;
    const head = [
      "<b>💰 Terima cicilan piutang penjualan</b>",
      d.number ? `Nota: ${esc(String(d.number))} · ${esc(String(d.custName))}\nSisa tagihan: ${idr(Number(d.rest))}${d.due ? ` · jatuh tempo ${fmtDate(dateOnly(String(d.due)))}` : ""}` : "",
      d.amount ? `Diterima: <b>${idr(Number(d.amount))}</b>${Number(d.amount) >= Number(d.rest) ? " (lunas)" : ` · sisa ${idr(Number(d.rest) - Number(d.amount))}`}` : "",
      d.bankName ? `Ke rekening: ${esc(String(d.bankName))}` : "",
      s.step === "confirm" ? (d.proofPath ? "Bukti: terlampir 📎" : "Bukti: tidak ada") : "",
    ].filter(Boolean).join("\n");
    const page = Number(d.page ?? 0);
    switch (s.step) {
      case "sale": {
        const rows = await openSales(page * PAGE);
        const today = dayRange(todayStr()).end;
        return {
          text: `${head}\nPilih nota yang dibayar:`,
          buttons: [...rows.slice(0, PAGE).map((x) => [{ text: `${x.dueDate && x.dueDate < today ? "⚠️ " : ""}${x.number.replace(/^JUAL-/, "")} · ${x.customerName.slice(0, 16)} · sisa ${idr(Number(x.total - x.paid))}`.slice(0, 60), callback_data: `f:${x.id}` }]), ...pager(page, rows.length > PAGE), cancelRow],
        };
      }
      case "amount":
        return { text: `${head}\n\nBerapa yang diterima? Pilih atau ✍️ ketik nominal.`, buttons: [[{ text: `Lunas (${idr(Number(d.rest))})`, callback_data: "f:full" }], cancelRow] };
      case "bank":
        return { text: `${head}\nDiterima di rekening:`, buttons: [...(await bankButtons()), cancelRow] };
      case "proof":
        return { text: `${head}\n\n📷 Kirim <b>foto bukti transfer</b> di sini, atau lewati.`, buttons: [[{ text: "Lewati (tanpa bukti)", callback_data: "f:skip" }], cancelRow] };
      case "confirm":
        return { text: `${head}\n\nSimpan pembayaran ini? Jurnal & saldo rekening langsung tercatat.`, buttons: [[{ text: "✅ Simpan", callback_data: "f:ok" }], [{ text: "📷 Kirim ulang bukti", callback_data: "f:again" }], cancelRow] };
    }
    return { text: head };
  },
  async answer(ctx, s, v, fromText) {
    const d = s.data;
    switch (s.step) {
      case "sale": {
        const x = fromText ? null : await prisma.sale.findUnique({ where: { id: v } });
        if (!x || x.cancelledAt || x.paid >= x.total) return "Pilih nota dengan tombol";
        d.saleId = x.id;
        d.number = x.number;
        d.custName = x.customerName;
        d.rest = Number(x.total - x.paid);
        d.due = x.dueDate ? todayStr(x.dueDate) : null;
        s.step = "amount";
        return null;
      }
      case "amount": {
        const n = !fromText && v === "full" ? Number(d.rest) : parseIDR(v);
        if (n == null || !(n > 0) || n > Number(d.rest)) return `Nominal harus 1 – ${idr(Number(d.rest))}`;
        d.amount = n;
        s.step = "bank";
        return null;
      }
      case "bank": {
        const b = fromText ? null : await prisma.bankAccount.findUnique({ where: { id: v } });
        if (!b) return "Pilih rekening dengan tombol";
        d.bankId = b.id;
        d.bankName = b.name;
        s.step = "proof";
        return null;
      }
      case "proof":
        if (fromText) return "Kirim FOTO bukti transfer, atau tekan Lewati";
        if (v !== "skip") return "Kirim foto bukti transfer, atau tekan Lewati";
        d.proofPath = null;
        s.step = "confirm";
        return null;
      case "confirm": {
        if (v === "again") {
          s.step = "proof";
          return null;
        }
        if (v !== "ok") return "Tekan Simpan atau Batal";
        if (!can(ctx.i, "sales.manage")) return "Anda tidak berwenang";
        if (await guardDup(s, v, { direction: "MASUK", amount: Number(d.amount), date: new Date(), accountId: String(d.bankId), text: `cicilan piutang ${d.custName ?? ""} ${d.number ?? ""}` })) return null;
        try {
          const r = await paySale(
            String(d.saleId),
            { amount: Number(d.amount), bankAccountId: String(d.bankId), date: jakartaDateTime(todayStr(), "12:00"), note: "via Telegram", proofPath: d.proofPath ? String(d.proofPath) : null, proofMime: d.proofPath ? "image/jpeg" : null },
            actorOf(ctx.i),
          );
          d.lunas = r.lunas ? 1 : 0;
          d.left = r.rest;
        } catch (e) {
          return errMsg(e);
        }
        return "done";
      }
    }
    return null;
  },
  async finish(_ctx, s) {
    const d = s.data;
    return {
      text: `✅ <b>${Number(d.lunas) ? `Nota ${esc(String(d.number))} lunas` : `Cicilan ${esc(String(d.number))} dibukukan`}</b>\n${esc(String(d.custName))}: ${idr(Number(d.amount))} ke ${esc(String(d.bankName))}${d.proofPath ? " · bukti terlampir" : ""}${Number(d.lunas) ? "" : `\nSisa piutang: <b>${idr(Number(d.left))}</b>`}`,
      buttons: [[{ text: "📄 Nota JPG", callback_data: `m:nota:${d.saleId}` }], [{ text: "💰 Cicilan lain", callback_data: "f:start:jcil" }, ...menuBtn]],
    };
  },
};

export const SALES_FLOWS: Record<string, FlowDef> = { jual: salesMenu, jnew: newSale, jcil: salePayment };

// =====================================================================
// Pengingat piutang jatuh tempo (job harian 08.00 WIB)
// =====================================================================
export const RECEIVABLE_NOTICE = "PIUTANG_JATUH_TEMPO";

/** Nota belum lunas yang jatuh tempo hari ini / sudah lewat dan belum diingatkan hari ini */
export async function dueSales(now: Date = new Date()) {
  const date = todayStr(now);
  const { start, end } = dayRange(date);
  const rows = await prisma.sale.findMany({ where: { cancelledAt: null, dueDate: { lt: end }, paid: { lt: prisma.sale.fields.total } }, include: { customer: { select: { phone: true } } }, orderBy: [{ dueDate: "asc" }, { number: "asc" }] });
  const done = await prisma.notificationLog.findMany({ where: { type: RECEIVABLE_NOTICE, status: "TERKIRIM", at: { gte: start, lt: end }, target: { in: rows.map((r) => r.id) } }, select: { target: true } });
  const skip = new Set(done.map((x) => x.target));
  return rows.filter((r) => !skip.has(r.id)).map((r) => ({ ...r, today: r.dueDate! >= start, lateDays: Math.max(0, Math.round((dateOnly(date).getTime() - dateOnly(todayStr(r.dueDate!)).getTime()) / 86_400_000)) }));
}

export function receivableReminderText(rows: Awaited<ReturnType<typeof dueSales>>) {
  if (!rows.length) return "";
  const line = (r: (typeof rows)[number]) => `• ${esc(r.number)} · ${esc(r.customerName)}${r.customer?.phone ? ` (${esc(r.customer.phone)})` : ""}: sisa <b>${idr(Number(r.total - r.paid))}</b>${r.today ? "" : ` · lewat ${r.lateDays} hari`}`;
  const today = rows.filter((r) => r.today);
  const late = rows.filter((r) => !r.today);
  const total = rows.reduce((t, r) => t + Number(r.total - r.paid), 0);
  return [
    "<b>📅 Pengingat piutang penjualan</b>",
    today.length ? `\n<b>Jatuh tempo hari ini (${today.length})</b>\n${today.map(line).join("\n")}` : "",
    late.length ? `\n<b>Lewat jatuh tempo (${late.length})</b>\n${late.map(line).join("\n")}` : "",
    `\nTotal: <b>${idr(total)}</b>. Tagih pelanggan, lalu catat pembayarannya.`,
  ].filter(Boolean).join("\n");
}
