import type { HandoverKind } from "@prisma/client";
import { prisma } from "./db";
import { giveAdvance, PayrollError } from "./payroll";
import { createPurchase, termFor } from "./purchase";
import { nextInstallment, splitPayment } from "./payables";
import { applyReserveOption } from "./reserve";
import { bookPayablePayment, bookReserveTransfer, FinanceError } from "./finance";
import type { ReservePart } from "./reserveSync";
import { findSupplierByName } from "./suppliers";
import { readProofAmount, repayTalangan, talanganSummary } from "./talangan";
import { saveProof } from "./storage";
import { BoronganError, boronganScope, BORONGAN_ROLE_LABEL, createHandover, HANDOVER_LABEL, payLines, receiveHandover, recordResult, settlePoint, type Scope } from "./borongan";
import { StockError } from "./stock";
import { idr, parseIDR } from "./money";
import { addDays, dateOnly, fmtDate, fmtDateTime, jakartaDateTime, todayStr } from "./time";
import { esc, type InlineButton } from "./telegram";
import { cancelRow, can, chunk, fmtQty, itemChoices, itemPrompt, MENU_TEXT, PAGE, pager, parseCount, parseQty, type Ctx, type Prompt, type Session } from "./botKit";
import type { BotIdent } from "./botMenu";
import { SALES_FLOWS, salesMenuRows } from "./botSales";
import { createDraft, draftMessage, type DraftInput } from "./botDraft";
import { ackIds, guardDup } from "./botDup";

/**
 * Isian bot Telegram Tahap 3: kasbon, pembelian bahan baku, dan borongan tetangga
 * (terima serah terima, catat setoran hasil, kirim bahan/hasil, upah belum dibayar & bayar upah).
 * Semua memakai fungsi lib yang sama dengan halaman web, jadi aturan, stok, dan jurnalnya identik.
 */

type Answer = string | null | "done" | Prompt;
export type FlowDef = {
  start: (ctx: Ctx) => Promise<Session | string | Prompt>;
  prompt: (s: Session, i: BotIdent) => Promise<Prompt>;
  answer: (ctx: Ctx, s: Session, v: string, fromText: boolean) => Promise<Answer>;
  finish: (ctx: Ctx, s: Session) => Promise<Prompt>;
};

type Line = { itemId: string; name: string; unit: string; qty: number; amount?: number };
const getLines = (s: Session): Line[] => JSON.parse(String(s.data.lines ?? "[]"));
const setLines = (s: Session, l: Line[]) => void (s.data.lines = JSON.stringify(l));
const linesText = (l: Line[]) => l.map((x, k) => `${k + 1}. ${esc(x.name)}: ${fmtQty(x.qty)} ${esc(x.unit)}${x.amount ? ` · ${idr(x.amount)}` : ""}`).join("\n");
const menuBtn: InlineButton[] = [{ text: MENU_TEXT, callback_data: "m:home" }];
const actorOf = (i: BotIdent) => ({ id: i.userId, name: i.user.name });
const scopeOf = (i: BotIdent) => boronganScope(prisma, { id: i.userId, can: (p) => i.perms.has(p) });
const errMsg = (e: unknown) => (e instanceof PayrollError || e instanceof StockError || e instanceof BoronganError ? e.message : (e as Error).message.slice(0, 200));

export function t3MenuRows(i: BotIdent): InlineButton[][] {
  const row: InlineButton[] = [];
  if (can(i, "payroll.approve") || (can(i, "payroll.self") && i.user.employeeId)) row.push({ text: "💵 Kasbon", callback_data: "f:start:kas" });
  if (can(i, "finance.approve")) row.push({ text: "🛒 Pembelian", callback_data: "f:start:beli" });
  const rows: InlineButton[][] = row.length ? [row] : [];
  rows.push(...salesMenuRows(i));
  if (can(i, "borongan.view", "borongan.point", "borongan.manage")) rows.push([{ text: "🧑‍🏭 Borongan", callback_data: "f:start:bor" }]);
  if (can(i, "finance.approve")) rows.push([{ text: "💸 Kembalikan dana talangan", callback_data: "f:start:tlg" }]);
  return rows;
}

async function banks() {
  return prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } });
}
const bankButtons = async () => chunk((await banks()).map((b) => ({ text: b.name, callback_data: `f:${b.id}` })), 2);

// =====================================================================
// Kasbon
// =====================================================================
async function ownAdvances(i: BotIdent): Promise<string> {
  if (!i.user.employeeId) return "";
  const rows = await prisma.cashAdvance.findMany({ where: { employeeId: i.user.employeeId, cancelledAt: null }, orderBy: { date: "desc" }, take: 20 });
  const open = rows.filter((a) => a.repaid < a.amount);
  if (!open.length) return "Anda tidak punya kasbon yang belum lunas. ✅";
  const left = open.reduce((t, a) => t + Number(a.amount - a.repaid), 0);
  return ["<b>Kasbon saya (belum lunas)</b>", ...open.map((a) => `• ${a.number} · ${fmtDate(a.date)}: sisa ${idr(Number(a.amount - a.repaid))} dari ${idr(a.amount)}${a.installment > BigInt(0) ? ` · potong ${idr(a.installment)}/gajian` : " · potong sekaligus"}`), `Total sisa: <b>${idr(left)}</b>`, "Kasbon dipotong otomatis dari gaji berikutnya."].join("\n");
}

const kasbon: FlowDef = {
  async start(ctx) {
    const { i } = ctx;
    const mine = can(i, "payroll.self") && i.user.employeeId ? await ownAdvances(i) : "";
    const rows: InlineButton[][] = [];
    if (can(i, "payroll.approve")) rows.push([{ text: "➕ Beri kasbon karyawan", callback_data: "f:start:ksb" }]);
    rows.push(menuBtn);
    return { text: `<b>💵 Kasbon</b>${mine ? `\n\n${mine}` : ""}`, buttons: rows };
  },
  async prompt() {
    return { text: "" };
  },
  async answer() {
    return null;
  },
  async finish() {
    return { text: "" };
  },
};

const giveKasbon: FlowDef = {
  async start(ctx) {
    if (!can(ctx.i, "payroll.approve")) return "Anda tidak berwenang memberi kasbon";
    return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "ksb", step: "emp", data: { page: 0 } };
  },
  async prompt(s) {
    const d = s.data;
    const head = ["<b>💵 Beri kasbon</b>", d.empName ? `Karyawan: ${esc(String(d.empName))}` : "", d.amount ? `Nominal: ${idr(Number(d.amount))}` : "", d.inst != null ? `Potongan: ${Number(d.inst) > 0 ? `${idr(Number(d.inst))}/gajian` : "sekaligus di gajian berikutnya"}` : "", d.bankName ? `Dari rekening: ${esc(String(d.bankName))}` : "", d.note ? `Catatan: ${esc(String(d.note))}` : ""].filter(Boolean).join("\n");
    const page = Number(d.page ?? 0);
    switch (s.step) {
      case "emp": {
        const emps = await prisma.employee.findMany({ where: { status: "AKTIF" }, orderBy: { name: "asc" }, skip: page * PAGE, take: PAGE + 1 });
        return { text: `${head}\nPilih karyawan:`, buttons: [...chunk(emps.slice(0, PAGE).map((e) => ({ text: e.name.slice(0, 30), callback_data: `f:${e.id}` })), 2), ...pager(page, emps.length > PAGE), cancelRow] };
      }
      case "amount":
        return { text: `${head}\n\n✍️ Ketik nominal kasbon, contoh <code>500000</code> atau <code>500rb</code>`, buttons: [cancelRow] };
      case "inst":
        return { text: `${head}\n\n✍️ Ketik potongan per gajian (Rp), atau potong sekaligus.`, buttons: [[{ text: "Potong sekaligus", callback_data: "f:0" }], cancelRow] };
      case "bank":
        return { text: `${head}\nDibayar dari rekening:`, buttons: [...(await bankButtons()), cancelRow] };
      case "note":
        return { text: `${head}\n\n✍️ Ketik keperluan/catatan, atau lewati.`, buttons: [[{ text: "Lewati", callback_data: "f:skip" }], cancelRow] };
      case "confirm":
        return { text: `${head}\n\nBerikan kasbon ini? Jurnal & saldo rekening langsung tercatat.`, buttons: [[{ text: "✅ Simpan", callback_data: "f:ok" }, { text: "❌ Batal", callback_data: "f:x" }]] };
    }
    return { text: head };
  },
  async answer(ctx, s, v, fromText) {
    const d = s.data;
    switch (s.step) {
      case "emp": {
        const e = fromText ? null : await prisma.employee.findUnique({ where: { id: v } });
        if (!e || e.status !== "AKTIF") return "Pilih karyawan dengan tombol";
        d.empId = e.id;
        d.empName = e.name;
        s.step = "amount";
        return null;
      }
      case "amount": {
        const n = parseIDR(v);
        if (!n || n <= 0) return "Ketik nominal, contoh 500000 atau 500rb";
        d.amount = n;
        s.step = "inst";
        return null;
      }
      case "inst": {
        const n = !fromText ? 0 : parseIDR(v);
        if (n == null || n < 0 || n > Number(d.amount)) return `Potongan harus 0 – ${idr(Number(d.amount))}`;
        d.inst = n;
        s.step = "bank";
        return null;
      }
      case "bank": {
        const b = fromText ? null : await prisma.bankAccount.findUnique({ where: { id: v } });
        if (!b) return "Pilih rekening dengan tombol";
        d.bankId = b.id;
        d.bankName = b.name;
        s.step = "note";
        return null;
      }
      case "note":
        d.note = fromText ? v.slice(0, 200) : null;
        s.step = "confirm";
        return null;
      case "confirm":
        if (v !== "ok") return "Tekan Simpan atau Batal";
        if (!can(ctx.i, "payroll.approve")) return "Anda tidak berwenang";
        if (await guardDup(s, v, { direction: "KELUAR", amount: Number(d.amount), date: new Date(), accountId: String(d.bankId), text: `kasbon ${d.empName ?? ""} ${d.note ?? ""}` })) return null;
        try {
          const a = await giveAdvance({ employeeId: String(d.empId), amount: Number(d.amount), installment: Number(d.inst), bankAccountId: String(d.bankId), date: todayStr(), note: d.note ? String(d.note) : null }, actorOf(ctx.i));
          d.number = a.number;
        } catch (e) {
          return errMsg(e);
        }
        return "done";
    }
    return null;
  },
  async finish(_ctx, s) {
    return { text: `✅ <b>Kasbon ${esc(String(s.data.number))} tercatat</b>\n${esc(String(s.data.empName))}: ${idr(Number(s.data.amount))}, dipotong otomatis dari gaji berikutnya.`, buttons: [[{ text: "➕ Kasbon lain", callback_data: "f:start:ksb" }, ...menuBtn]] };
  },
};

// =====================================================================
// Pembelian bahan baku
// =====================================================================

/** Langkah berikutnya untuk isian pembelian yang sudah terisi dari pesan/bukti transfer */
function nextPrefilled(s: Session): string {
  const d = s.data;
  if (!d.supName) return "sup";
  if (d.itemId) return d.qty == null ? "qty" : "amt";
  const lines = getLines(s);
  if (!lines.length) return "item";
  if (!d.pre) return "more";
  const total = lines.reduce((t, l) => t + (l.amount ?? 0), 0);
  if (d.paid == null) d.paid = total;
  if (Number(d.paid) > 0 && !d.bankId) return "bank";
  if (Number(d.paid) < total && !d.due) return "due";
  return "confirm";
}

export type PurchasePrefill = {
  item: { id: string; name: string; unit: string; supplierId: string | null };
  others: { id: string; name: string }[];
  qty: number | null;
  amount: number | null;
  bankId: string | null;
  supplier: { id: string; name: string } | null;
  date: string | null;
  time: string | null;
  note: string | null;
  proofPath: string | null;
  /** Data draft transaksi biasa, dipakai bila pengguna memilih "Bukan pembelian" */
  tx: unknown;
};

/** Mulai isian pembelian dari pesan/foto yang dikenali menyebut bahan baku di master data */
export async function prefilledPurchase(ctx: Ctx, p: PurchasePrefill): Promise<Session | null> {
  if (!can(ctx.i, "finance.approve")) return null;
  const bank = p.bankId ? await prisma.bankAccount.findUnique({ where: { id: p.bankId } }) : null;
  const sup = p.supplier ?? (p.item.supplierId ? await prisma.supplier.findUnique({ where: { id: p.item.supplierId }, select: { id: true, name: true } }) : null);
  const s: Session = {
    chatId: ctx.chatId,
    userId: ctx.i.userId,
    flow: "beli",
    step: "sup",
    data: {
      page: 0,
      pre: 1,
      lines: "[]",
      supId: sup?.id ?? null,
      supName: sup?.name ?? null,
      supNew: 0,
      itemId: p.item.id,
      itemName: p.item.name,
      unit: p.item.unit,
      qty: p.qty,
      preAmount: p.amount,
      bankId: bank?.id ?? null,
      bankName: bank?.name ?? null,
      date: p.date,
      time: p.time,
      note: p.note ? p.note.slice(0, 200) : null,
      proofPath: p.proofPath,
      others: p.others.length ? JSON.stringify(p.others) : null,
      tx: JSON.stringify(p.tx),
    },
  };
  // Jumlah & nominal sudah ada: barang langsung masuk daftar
  if (p.qty && p.amount) {
    setLines(s, [{ itemId: p.item.id, name: p.item.name, unit: p.item.unit, qty: p.qty, amount: p.amount }]);
    s.data.itemId = s.data.itemName = s.data.qty = s.data.preAmount = null;
  }
  s.step = nextPrefilled(s);
  return s;
}

const purchase: FlowDef = {
  async start(ctx) {
    if (!can(ctx.i, "finance.approve")) return "Anda tidak berwenang mencatat pembelian";
    return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "beli", step: "sup", data: { page: 0, lines: "[]" } };
  },
  async prompt(s) {
    const d = s.data;
    const lines = getLines(s);
    const total = lines.reduce((t, l) => t + (l.amount ?? 0), 0);
    const head = [
      "<b>🛒 Pembelian bahan baku</b>",
      d.supName ? `Supplier: ${esc(String(d.supName))}${d.supNew ? " (baru)" : ""}` : "",
      lines.length ? `${linesText(lines)}\nTagihan: <b>${idr(total)}</b>` : "",
      d.itemName && s.step !== "item" ? `Barang: ${esc(String(d.itemName))}${d.qty ? ` · ${fmtQty(Number(d.qty))} ${esc(String(d.unit))}` : ""}` : "",
      d.paid != null ? `Dibayar sekarang: ${idr(Number(d.paid))}${Number(d.paid) < total ? ` · sisa hutang ${idr(total - Number(d.paid))}` : " (lunas)"}` : "",
      d.bankName ? `Dari rekening: ${esc(String(d.bankName))}` : "",
      d.due ? `Jatuh tempo: ${fmtDate(dateOnly(String(d.due)))}` : "",
      d.note ? `Catatan: ${esc(String(d.note))}` : "",
      d.date && d.date !== todayStr() ? `Tanggal: ${fmtDate(dateOnly(String(d.date)))}` : "",
      d.pre ? "<i>Dikenali dari pesan/bukti transfer sesuai master bahan baku.</i>" : "",
    ].filter(Boolean).join("\n");
    const page = Number(d.page ?? 0);
    // Pesan yang dikenali sebagai pembelian: tetap bisa dicatat sebagai transaksi biasa
    const plainRow: InlineButton[][] = d.tx ? [[{ text: "📝 Bukan pembelian, catat transaksi biasa", callback_data: "f:plain" }]] : [];
    const others: { id: string; name: string }[] = d.others ? JSON.parse(String(d.others)) : [];
    switch (s.step) {
      case "sup": {
        const sups = await prisma.supplier.findMany({ where: { active: true }, orderBy: { name: "asc" }, skip: page * PAGE, take: PAGE + 1 });
        return { text: `${head}\nPilih supplier, atau ✍️ ketik nama supplier baru:`, buttons: [...chunk(sups.slice(0, PAGE).map((x) => ({ text: x.name.slice(0, 30), callback_data: `f:${x.id}` })), 2), ...pager(page, sups.length > PAGE), ...plainRow, cancelRow] };
      }
      case "item":
        return itemPrompt(head);
      case "qty":
        return { text: `${head}\n\n✍️ Ketik jumlah dalam <b>${esc(String(d.unit))}</b>, contoh <code>10</code>`, buttons: [...plainRow, cancelRow] };
      case "amt":
        return { text: `${head}\n\n✍️ Ketik <b>total harga</b> barang ini (Rp), contoh <code>850000</code> atau <code>850rb</code>`, buttons: [...plainRow, cancelRow] };
      case "more":
        return { text: `${head}\n\nAda barang lain di nota ini?`, buttons: [[{ text: "➕ Tambah barang", callback_data: "f:add" }, { text: "Selesai ➡", callback_data: "f:done" }], cancelRow] };
      case "paid":
        return { text: `${head}\n\nBerapa yang dibayar sekarang? Pilih atau ✍️ ketik nominal (DP).`, buttons: [[{ text: `Lunas (${idr(total)})`, callback_data: "f:full" }], [{ text: "Belum bayar / tempo", callback_data: "f:zero" }], cancelRow] };
      case "bank":
        return { text: `${head}\nDibayar dari rekening:`, buttons: [...(await bankButtons()), ...plainRow, cancelRow] };
      case "due":
        return { text: `${head}\nJatuh tempo sisa hutang:`, buttons: [[{ text: "7 hari", callback_data: "f:7" }, { text: "14 hari", callback_data: "f:14" }, { text: "30 hari", callback_data: "f:30" }], cancelRow] };
      case "note":
        return { text: `${head}\n\n✍️ Ketik catatan/no. nota, atau lewati.`, buttons: [[{ text: "Lewati", callback_data: "f:skip" }], cancelRow] };
      case "confirm":
        return {
          text: `${head}\n\nSimpan pembelian ini? Stok masuk gudang bahan baku dan jurnal langsung tercatat.${others.length ? `\nBarang lain di pesan: ${others.map((o) => esc(o.name)).join(", ")}. Tekan ➕ bila ikut dibeli.` : ""}`,
          buttons: [[{ text: "✅ Simpan", callback_data: "f:ok" }, { text: "➕ Tambah barang", callback_data: "f:add" }], ...plainRow, [{ text: "❌ Batal", callback_data: "f:x" }]],
        };
    }
    return { text: head };
  },
  async answer(ctx, s, v, fromText) {
    const d = s.data;
    const lines = getLines(s);
    const total = lines.reduce((t, l) => t + (l.amount ?? 0), 0);
    switch (s.step) {
      case "sup":
        if (fromText) {
          const name = v.trim().slice(0, 80);
          if (name.length < 2) return "Nama supplier minimal 2 huruf";
          // Cocokkan dengan master (termasuk nama lain & tanpa kata "supplier"/"toko") agar tidak dobel
          const found = await findSupplierByName(prisma, name);
          d.supId = found?.id ?? null;
          d.supName = found?.name ?? name;
          d.supNew = found ? 0 : 1;
        } else {
          const sup = await prisma.supplier.findUnique({ where: { id: v } });
          if (!sup) return "Supplier tidak ditemukan";
          d.supId = sup.id;
          d.supName = sup.name;
          d.supNew = 0;
        }
        s.step = nextPrefilled(s);
        return null;
      case "item": {
        if (fromText) return itemChoices("<b>🛒 Pembelian bahan baku</b>", v);
        if (v === "again") return null;
        const it = await prisma.item.findUnique({ where: { id: v } });
        if (!it) return "Barang tidak ditemukan";
        d.itemId = it.id;
        d.itemName = it.name;
        d.unit = it.unit;
        d.qty = null;
        s.step = "qty";
        return null;
      }
      case "qty": {
        const n = parseQty(v);
        if (n == null || !(n > 0)) return "Ketik jumlah lebih dari 0";
        d.qty = n;
        if (d.pre && d.preAmount) {
          lines.push({ itemId: String(d.itemId), name: String(d.itemName), unit: String(d.unit), qty: n, amount: Number(d.preAmount) });
          setLines(s, lines);
          d.itemId = d.itemName = d.qty = d.preAmount = null;
          s.step = nextPrefilled(s);
        } else s.step = "amt";
        return null;
      }
      case "amt": {
        const n = parseIDR(v);
        if (!n || n <= 0) return "Ketik total harga, contoh 850000 atau 850rb";
        lines.push({ itemId: String(d.itemId), name: String(d.itemName), unit: String(d.unit), qty: Number(d.qty), amount: n });
        setLines(s, lines);
        d.itemId = d.itemName = d.qty = null;
        s.step = d.pre ? nextPrefilled(s) : "more";
        return null;
      }
      case "more":
        if (fromText) return "Pilih dengan tombol";
        s.step = v === "add" ? "item" : "paid";
        return null;
      case "paid": {
        const n = !fromText && v === "full" ? total : !fromText && v === "zero" ? 0 : parseIDR(v);
        if (n == null || n < 0 || n > total) return `Nominal dibayar harus 0 – ${idr(total)}`;
        d.paid = n;
        s.step = n > 0 ? "bank" : "due";
        return null;
      }
      case "bank": {
        const b = fromText ? null : await prisma.bankAccount.findUnique({ where: { id: v } });
        if (!b) return "Pilih rekening dengan tombol";
        d.bankId = b.id;
        d.bankName = b.name;
        s.step = Number(d.paid) < total ? "due" : d.pre ? "confirm" : "note";
        return null;
      }
      case "due": {
        const days = Number(v);
        if (fromText || ![7, 14, 30].includes(days)) return "Pilih jatuh tempo dengan tombol";
        d.due = addDays(todayStr(), days);
        s.step = "note";
        return null;
      }
      case "note":
        d.note = fromText ? v.slice(0, 200) : null;
        s.step = "confirm";
        return null;
      case "confirm": {
        if (v === "add") {
          // Tambah barang lain: lanjut isian biasa (jumlah dibayar ditanyakan ulang karena tagihan berubah)
          d.pre = 0;
          d.paid = null;
          s.step = "item";
          return null;
        }
        if (v !== "ok") return "Tekan Simpan atau Batal";
        if (!can(ctx.i, "finance.approve")) return "Anda tidak berwenang";
        if (Number(d.paid) > 0 && (await guardDup(s, v, { direction: "KELUAR", amount: Number(d.paid), date: jakartaDateTime(d.date ? String(d.date) : todayStr(), d.time ? String(d.time) : "12:00"), accountId: d.bankId ? String(d.bankId) : null, text: `${d.supName ?? ""} ${lines.map((l) => l.name).join(" ")} ${d.note ?? ""}` }))) return null;
        try {
          const store = await prisma.setting.findUnique({ where: { key: "default_store_id" } });
          if (!store) return "Toko default belum diatur di Pengaturan";
          const paid = Number(d.paid);
          const term = termFor(total, paid);
          const p = await createPurchase(
            {
              supplierId: d.supId ? String(d.supId) : null,
              newSupplierName: d.supId ? null : String(d.supName),
              storeId: store.value,
              date: jakartaDateTime(d.date ? String(d.date) : todayStr(), d.time ? String(d.time) : "12:00"),
              term,
              lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, amount: l.amount })),
              paidNow: term === "BERTAHAP" ? paid : 0,
              bankAccountId: paid > 0 ? String(d.bankId) : null,
              dueDate: term !== "LUNAS" && d.due ? jakartaDateTime(String(d.due), "12:00") : null,
              note: [d.note ? String(d.note) : "", "via Telegram"].filter(Boolean).join(" · "),
              proofPath: d.proofPath ? String(d.proofPath) : null,
              proofMime: d.proofPath ? "image/jpeg" : null,
            },
            actorOf(ctx.i),
          );
          d.number = p.number;
          d.term = term;
        } catch (e) {
          return errMsg(e);
        }
        return "done";
      }
    }
    return null;
  },
  async finish(_ctx, s) {
    const lines = getLines(s);
    return { text: `✅ <b>Pembelian ${esc(String(s.data.number))} tercatat</b>${s.data.term === "LUNAS" ? " (lunas)" : " (ada hutang)"}\n${esc(String(s.data.supName))}\n${linesText(lines)}\nStok sudah masuk gudang bahan baku.`, buttons: [[{ text: "🛒 Pembelian lain", callback_data: "f:start:beli" }, ...menuBtn]] };
  },
};

// =====================================================================
// Borongan tetangga
// =====================================================================
async function myPoints(scope: Scope) {
  return prisma.boronganPoint.findMany({ where: { active: true, ...(scope.all ? {} : { id: { in: scope.pointIds } }) }, orderBy: { code: "asc" } });
}

/** Serah terima yang menunggu konfirmasi pengguna ini */
async function pendingFor(scope: Scope) {
  return prisma.boronganHandover.findMany({
    where: { status: "DIKIRIM", OR: [{ kind: "KIRIM", ...(scope.all ? {} : { pointId: { in: scope.pointIds } }) }, ...(scope.all ? [{ kind: "KEMBALI" as HandoverKind }] : [])] },
    include: { point: true, lines: { include: { item: true } }, driver: true },
    orderBy: { date: "asc" },
    take: 10,
  });
}

const boronganMenu: FlowDef = {
  async start(ctx) {
    const { i } = ctx;
    const scope = await scopeOf(i);
    const canWork = can(i, "borongan.manage") || (can(i, "borongan.point") && scope.pointIds.length > 0);
    const pend = canWork ? await pendingFor(scope) : [];
    const rows: InlineButton[][] = [];
    if (canWork) {
      rows.push([{ text: `📥 Terima serah terima${pend.length ? ` (${pend.length})` : ""}`, callback_data: "f:start:bter" }]);
      rows.push([{ text: "✍️ Catat setoran hasil", callback_data: "f:start:bset" }]);
      rows.push([{ text: scope.all ? "🚚 Kirim bahan ke titik" : "🚚 Kirim hasil ke gudang", callback_data: "f:start:bkir" }]);
    }
    rows.push([{ text: "💰 Upah belum dibayar", callback_data: "f:start:bupah" }]);
    rows.push(menuBtn);
    const note = can(i, "borongan.point") && !scope.all && !scope.pointIds.length ? "\n\n⚠️ Akun Anda belum terdaftar sebagai koordinator titik aktif." : "";
    return { text: `<b>🧑‍🏭 Borongan tetangga</b>${note}`, buttons: rows };
  },
  prompt: async () => ({ text: "" }),
  answer: async () => null,
  finish: async () => ({ text: "" }),
};

/** Terima serah terima: pilih dari daftar, lihat isi, lalu konfirmasi */
const receive: FlowDef = {
  async start(ctx) {
    const scope = await scopeOf(ctx.i);
    if (!can(ctx.i, "borongan.manage") && !(can(ctx.i, "borongan.point") && scope.pointIds.length)) return "Anda tidak berwenang";
    const s: Session = { chatId: ctx.chatId, userId: ctx.i.userId, flow: "bter", step: "pick", data: {} };
    // Tidak ada yang menunggu: tampilkan info saja tanpa membuka isian
    if (!(await pendingFor(scope)).length) return receivePrompt(ctx.i, s);
    return s;
  },
  prompt: (s, i) => receivePrompt(i, s),
  async answer(ctx, s, v, fromText) {
    if (fromText) return "Pilih dengan tombol";
    const scope = await scopeOf(ctx.i);
    if (s.step === "pick") {
      s.data.id = v;
      s.step = "confirm";
      return null;
    }
    if (v !== "ok") return "Tekan Terima atau Batal";
    try {
      await receiveHandover(String(s.data.id), actorOf(ctx.i), scope);
    } catch (e) {
      return errMsg(e);
    }
    return "done";
  },
  async finish(_ctx, s) {
    const h = await prisma.boronganHandover.findUnique({ where: { id: String(s.data.id) }, include: { point: true } });
    return { text: `✅ <b>Serah terima ${esc(h?.number ?? "")} diterima</b>\n${h?.kind === "KIRIM" ? `Bahan sudah masuk stok ${esc(h.point.name)}.` : "Hasil sudah masuk gudang."}`, buttons: [[{ text: "📥 Serah terima lain", callback_data: "f:start:bter" }, ...menuBtn]] };
  },
};

/** Daftar & detail serah terima yang menunggu konfirmasi pengguna ini */
async function receivePrompt(i: BotIdent, s: Session): Promise<Prompt> {
  const scope = await scopeOf(i);
  if (s.step === "pick") {
    const list = await pendingFor(scope);
    if (!list.length) return { text: "<b>📥 Terima serah terima</b>\nTidak ada serah terima yang menunggu Anda. ✅", buttons: [[{ text: "⬅ Borongan", callback_data: "f:start:bor" }, ...menuBtn]] };
    return {
      text: "<b>📥 Terima serah terima</b>\nPilih yang barangnya sudah Anda terima:",
      buttons: [...list.map((h) => [{ text: `${h.number} · ${h.kind === "KIRIM" ? "bahan →" : "hasil ←"} ${h.point.name}`.slice(0, 60), callback_data: `f:${h.id}` }]), cancelRow],
    };
  }
  const h = await prisma.boronganHandover.findUniqueOrThrow({ where: { id: String(s.data.id) }, include: { point: true, lines: { include: { item: true } }, driver: true } });
  return {
    text: [`<b>📥 ${esc(h.number)}</b> · ${HANDOVER_LABEL[h.kind]}`, `Titik: ${esc(h.point.name)}`, h.driver ? `Driver: ${esc(h.driver.name)}` : "", `Dikirim: ${fmtDate(h.date)} oleh ${esc(h.createdBy)}`, "", ...h.lines.map((l) => `• ${esc(l.item.name)}: ${fmtQty(Number(l.qty))} ${esc(l.item.unit)}`), h.note ? `\nCatatan: ${esc(h.note)}` : "", "", "Barang sudah diterima lengkap?"].filter((x) => x !== "").join("\n"),
    buttons: [[{ text: "✅ Terima", callback_data: "f:ok" }, { text: "❌ Batal", callback_data: "f:x" }]],
  };
}

/** Catat setoran hasil: titik → tugas → pekerja → jumlah */
const result: FlowDef = {
  async start(ctx) {
    const scope = await scopeOf(ctx.i);
    if (!can(ctx.i, "borongan.manage") && !(can(ctx.i, "borongan.point") && scope.pointIds.length)) return "Anda tidak berwenang";
    const pts = await myPoints(scope);
    if (!pts.length) return "Belum ada titik borongan aktif";
    const s: Session = { chatId: ctx.chatId, userId: ctx.i.userId, flow: "bset", step: "point", data: {} };
    if (pts.length === 1) {
      s.data.pointId = pts[0].id;
      s.data.pointName = pts[0].name;
      s.step = "task";
    }
    return s;
  },
  async prompt(s) {
    const d = s.data;
    const head = ["<b>✍️ Setoran hasil borongan</b>", d.pointName ? `Titik: ${esc(String(d.pointName))}` : "", d.taskName ? `Tugas: ${esc(String(d.taskName))}` : "", d.workerName ? `Pekerja: ${esc(String(d.workerName))}` : "", d.qty ? `Jumlah: ${d.qty} pcs` : "", d.saved ? `\nTersimpan hari ini: ${esc(String(d.saved))}` : ""].filter(Boolean).join("\n");
    switch (s.step) {
      case "point": {
        const pts = await prisma.boronganPoint.findMany({ where: { active: true }, orderBy: { code: "asc" } });
        return { text: `${head}\nPilih titik:`, buttons: [...chunk(pts.map((p) => ({ text: p.name, callback_data: `f:${p.id}` })), 2), cancelRow] };
      }
      case "task": {
        const tasks = await prisma.pieceTask.findMany({ where: { active: true }, orderBy: { name: "asc" } });
        return { text: `${head}\nPilih tugas:`, buttons: [...chunk(tasks.map((t) => ({ text: t.name.slice(0, 30), callback_data: `f:${t.id}` })), 2), cancelRow] };
      }
      case "worker": {
        const ws = await prisma.boronganPerson.findMany({ where: { active: true, role: "PEKERJA", pointId: String(d.pointId) }, orderBy: { name: "asc" } });
        if (!ws.length) return { text: `${head}\nBelum ada pekerja aktif di titik ini. Tambahkan dulu di website menu Borongan.`, buttons: [cancelRow] };
        return { text: `${head}\nPilih pekerja:`, buttons: [...chunk(ws.map((w) => ({ text: w.name.slice(0, 30), callback_data: `f:${w.id}` })), 2), ...(d.saved ? [[{ text: "Selesai ✅", callback_data: "f:end" }]] : []), cancelRow] };
      }
      case "qty":
        return { text: `${head}\n\n✍️ Ketik jumlah hasil (pcs), contoh <code>150</code>`, buttons: [cancelRow] };
      case "confirm":
        return { text: `${head}\n\nSimpan setoran ini? Stok bahan di titik berkurang dan hasil masuk stok titik.`, buttons: [[{ text: "✅ Simpan", callback_data: "f:ok" }, { text: "❌ Batal", callback_data: "f:x" }]] };
    }
    return { text: head };
  },
  async answer(ctx, s, v, fromText) {
    const d = s.data;
    switch (s.step) {
      case "point": {
        const p = fromText ? null : await prisma.boronganPoint.findUnique({ where: { id: v } });
        if (!p) return "Pilih titik dengan tombol";
        const scope = await scopeOf(ctx.i);
        if (!scope.all && !scope.pointIds.includes(p.id)) return "Anda hanya bisa mengurus titik Anda sendiri";
        d.pointId = p.id;
        d.pointName = p.name;
        s.step = "task";
        return null;
      }
      case "task": {
        const t = fromText ? null : await prisma.pieceTask.findUnique({ where: { id: v } });
        if (!t || !t.active) return "Pilih tugas dengan tombol";
        d.taskId = t.id;
        d.taskName = t.name;
        s.step = "worker";
        return null;
      }
      case "worker": {
        if (!fromText && v === "end") return "done";
        const w = fromText ? null : await prisma.boronganPerson.findUnique({ where: { id: v } });
        if (!w || w.pointId !== d.pointId || w.role !== "PEKERJA") return "Pilih pekerja dengan tombol";
        d.workerId = w.id;
        d.workerName = w.name;
        s.step = "qty";
        return null;
      }
      case "qty": {
        const n = parseCount(v);
        if (!n || n <= 0) return "Ketik angka bulat lebih dari 0";
        d.qty = n;
        s.step = "confirm";
        return null;
      }
      case "confirm": {
        if (v !== "ok") return "Tekan Simpan atau Batal";
        try {
          await recordResult({ pointId: String(d.pointId), taskId: String(d.taskId), workerId: String(d.workerId), date: dateOnly(todayStr()), qty: Number(d.qty), note: "via Telegram" }, actorOf(ctx.i), await scopeOf(ctx.i));
        } catch (e) {
          return errMsg(e);
        }
        // Lanjut pekerja berikutnya dengan titik & tugas yang sama
        d.saved = [d.saved ? String(d.saved) : "", `${d.workerName} ${d.qty} pcs`].filter(Boolean).join(", ");
        d.workerId = d.workerName = d.qty = null;
        s.step = "worker";
        return null;
      }
    }
    return null;
  },
  async finish(_ctx, s) {
    return { text: `✅ <b>Setoran tercatat</b>\n${esc(String(s.data.taskName))} · ${esc(String(s.data.pointName))}\n${esc(String(s.data.saved ?? ""))}`, buttons: [[{ text: "✍️ Setoran lain", callback_data: "f:start:bset" }, ...menuBtn]] };
  },
};

/** Kirim bahan ke titik (pengelola) atau hasil ke gudang (koordinator) lewat driver */
const sendGoods: FlowDef = {
  async start(ctx) {
    const scope = await scopeOf(ctx.i);
    if (!can(ctx.i, "borongan.manage") && !(can(ctx.i, "borongan.point") && scope.pointIds.length)) return "Anda tidak berwenang";
    const pts = await myPoints(scope);
    if (!pts.length) return "Belum ada titik borongan aktif";
    const s: Session = { chatId: ctx.chatId, userId: ctx.i.userId, flow: "bkir", step: "point", data: { kind: scope.all ? "KIRIM" : "KEMBALI", lines: "[]" } };
    if (pts.length === 1) {
      s.data.pointId = pts[0].id;
      s.data.pointName = pts[0].name;
      s.step = "driver";
    }
    return s;
  },
  async prompt(s) {
    const d = s.data;
    const lines = getLines(s);
    const head = [`<b>🚚 ${HANDOVER_LABEL[d.kind as HandoverKind]}</b>`, d.pointName ? `Titik: ${esc(String(d.pointName))}` : "", d.driverName ? `Driver: ${esc(String(d.driverName))}` : "", lines.length ? linesText(lines) : "", d.itemName && s.step === "qty" ? `Barang: ${esc(String(d.itemName))}` : "", d.note ? `Catatan: ${esc(String(d.note))}` : ""].filter(Boolean).join("\n");
    switch (s.step) {
      case "point": {
        const pts = await prisma.boronganPoint.findMany({ where: { active: true }, orderBy: { code: "asc" } });
        return { text: `${head}\nKe titik mana?`, buttons: [...chunk(pts.map((p) => ({ text: p.name, callback_data: `f:${p.id}` })), 2), cancelRow] };
      }
      case "driver": {
        const ds = await prisma.boronganPerson.findMany({ where: { active: true, role: "DRIVER" }, orderBy: { name: "asc" } });
        return { text: `${head}\nDiserahkan ke driver:`, buttons: [...chunk(ds.map((x) => ({ text: x.name, callback_data: `f:${x.id}` })), 2), [{ text: "Tanpa driver", callback_data: "f:none" }], cancelRow] };
      }
      case "item":
        return itemPrompt(head);
      case "qty":
        return { text: `${head}\n\n✍️ Ketik jumlah dalam <b>${esc(String(d.unit))}</b>`, buttons: [cancelRow] };
      case "more":
        return { text: `${head}\n\nAda barang lain?`, buttons: [[{ text: "➕ Tambah barang", callback_data: "f:add" }, { text: "Selesai ➡", callback_data: "f:done" }], cancelRow] };
      case "note":
        return { text: `${head}\n\n✍️ Ketik catatan, atau lewati.`, buttons: [[{ text: "Lewati", callback_data: "f:skip" }], cancelRow] };
      case "confirm":
        return { text: `${head}\n\nSimpan serah terima ini? Barang pindah ke driver dan menunggu dikonfirmasi penerima.`, buttons: [[{ text: "✅ Simpan", callback_data: "f:ok" }, { text: "❌ Batal", callback_data: "f:x" }]] };
    }
    return { text: head };
  },
  async answer(ctx, s, v, fromText) {
    const d = s.data;
    const lines = getLines(s);
    switch (s.step) {
      case "point": {
        const p = fromText ? null : await prisma.boronganPoint.findUnique({ where: { id: v } });
        if (!p) return "Pilih titik dengan tombol";
        d.pointId = p.id;
        d.pointName = p.name;
        s.step = "driver";
        return null;
      }
      case "driver": {
        if (fromText) return "Pilih driver dengan tombol";
        if (v !== "none") {
          const dr = await prisma.boronganPerson.findUnique({ where: { id: v } });
          if (!dr || dr.role !== "DRIVER") return "Pilih driver dengan tombol";
          d.driverId = dr.id;
          d.driverName = dr.name;
        }
        s.step = "item";
        return null;
      }
      case "item": {
        if (fromText) return itemChoices(`<b>🚚 ${HANDOVER_LABEL[d.kind as HandoverKind]}</b>`, v);
        if (v === "again") return null;
        const it = await prisma.item.findUnique({ where: { id: v } });
        if (!it) return "Barang tidak ditemukan";
        d.itemId = it.id;
        d.itemName = it.name;
        d.unit = it.unit;
        s.step = "qty";
        return null;
      }
      case "qty": {
        const n = parseQty(v);
        if (n == null || !(n > 0)) return "Ketik jumlah lebih dari 0";
        lines.push({ itemId: String(d.itemId), name: String(d.itemName), unit: String(d.unit), qty: n });
        setLines(s, lines);
        d.itemId = d.itemName = null;
        s.step = "more";
        return null;
      }
      case "more":
        if (fromText) return "Pilih dengan tombol";
        s.step = v === "add" ? "item" : "note";
        return null;
      case "note":
        d.note = fromText ? v.slice(0, 200) : null;
        s.step = "confirm";
        return null;
      case "confirm": {
        if (v !== "ok") return "Tekan Simpan atau Batal";
        const scope = await scopeOf(ctx.i);
        const kind = d.kind as HandoverKind;
        if (kind === "KIRIM" && !scope.all) return "Pengiriman bahan dicatat oleh pengelola gudang";
        if (kind === "KEMBALI" && !scope.all && !scope.pointIds.includes(String(d.pointId))) return "Anda hanya bisa mengurus titik Anda sendiri";
        try {
          const h = await createHandover({ kind, pointId: String(d.pointId), driverId: d.driverId ? String(d.driverId) : null, note: [d.note ? String(d.note) : "", "via Telegram"].filter(Boolean).join(" · "), lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty })) }, actorOf(ctx.i));
          d.number = h.number;
        } catch (e) {
          // Mis. stok asal kurang: ulangi isian barang dari awal
          setLines(s, []);
          s.step = "item";
          return `${errMsg(e)}. Isi ulang barangnya.`;
        }
        return "done";
      }
    }
    return null;
  },
  async finish(_ctx, s) {
    return { text: `✅ <b>Serah terima ${esc(String(s.data.number))} tercatat</b>\n${linesText(getLines(s))}\nMenunggu dikonfirmasi penerima.`, buttons: [[{ text: "⬅ Borongan", callback_data: "f:start:bor" }, ...menuBtn]] };
  },
};

/** Ringkasan upah belum dibayar per titik (+ tombol bayar untuk yang berwenang) */
async function unpaidSummary(i: BotIdent): Promise<Prompt> {
  const scope = await scopeOf(i);
  const pts = await myPoints(scope);
  const parts: string[] = ["<b>💰 Upah borongan belum dibayar</b>"];
  let any = false;
  for (const p of pts) {
    const rows = await prisma.boronganResult.findMany({ where: { pointId: p.id, settlementId: null }, include: { worker: true, coordinator: true, driver: true } });
    if (!rows.length) continue;
    any = true;
    const lines = payLines(rows);
    const total = lines.reduce((t, l) => t + l.amount, 0);
    parts.push("", `<b>${esc(p.name)}</b> · total ${idr(total)}`, ...lines.map((l) => `• ${esc(l.name)} (${BORONGAN_ROLE_LABEL[l.role]}): ${l.qty} pcs · ${idr(l.amount)}`));
  }
  if (!any) parts.push("", "Semua upah sudah dibayar. ✅");
  const rows: InlineButton[][] = [];
  if (any && can(i, "borongan.pay")) rows.push([{ text: "💸 Bayar upah titik", callback_data: "f:start:bbay" }]);
  rows.push([{ text: "⬅ Borongan", callback_data: "f:start:bor" }, ...menuBtn]);
  return { text: parts.join("\n"), buttons: rows };
}

const unpaid: FlowDef = {
  start: async (ctx) => unpaidSummary(ctx.i),
  prompt: async () => ({ text: "" }),
  answer: async () => null,
  finish: async () => ({ text: "" }),
};

/** Bayar upah satu titik sampai hari ini */
const pay: FlowDef = {
  async start(ctx) {
    if (!can(ctx.i, "borongan.pay")) return "Anda tidak berwenang membayar upah borongan";
    return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "bbay", step: "point", data: {} };
  },
  async prompt(s) {
    const d = s.data;
    const head = ["<b>💸 Bayar upah borongan</b>", d.pointName ? `Titik: ${esc(String(d.pointName))} · ${idr(Number(d.total))}` : "", d.bankName ? `Dari rekening: ${esc(String(d.bankName))}` : ""].filter(Boolean).join("\n");
    switch (s.step) {
      case "point": {
        const pts = await prisma.boronganPoint.findMany({ where: { active: true, results: { some: { settlementId: null } } }, orderBy: { code: "asc" } });
        return { text: `${head}\nPilih titik:`, buttons: [...chunk(pts.map((p) => ({ text: p.name, callback_data: `f:${p.id}` })), 2), cancelRow] };
      }
      case "bank":
        return { text: `${head}\nDibayar dari rekening:`, buttons: [...(await bankButtons()), cancelRow] };
      case "confirm":
        return { text: `${head}\n\nBayar semua upah titik ini sampai hari ini? Jurnal & saldo rekening langsung tercatat.`, buttons: [[{ text: "✅ Bayar", callback_data: "f:ok" }, { text: "❌ Batal", callback_data: "f:x" }]] };
    }
    return { text: head };
  },
  async answer(ctx, s, v, fromText) {
    const d = s.data;
    if (fromText) return "Pilih dengan tombol";
    switch (s.step) {
      case "point": {
        const p = await prisma.boronganPoint.findUnique({ where: { id: v } });
        if (!p) return "Titik tidak ditemukan";
        const rows = await prisma.boronganResult.findMany({ where: { pointId: p.id, settlementId: null, date: { lte: dateOnly(todayStr()) } }, include: { worker: true, coordinator: true, driver: true } });
        if (!rows.length) return "Tidak ada upah yang belum dibayar di titik ini";
        d.pointId = p.id;
        d.pointName = p.name;
        d.total = payLines(rows).reduce((t, l) => t + l.amount, 0);
        s.step = "bank";
        return null;
      }
      case "bank": {
        const b = await prisma.bankAccount.findUnique({ where: { id: v } });
        if (!b) return "Pilih rekening dengan tombol";
        d.bankId = b.id;
        d.bankName = b.name;
        s.step = "confirm";
        return null;
      }
      case "confirm":
        if (v !== "ok") return "Tekan Bayar atau Batal";
        if (!can(ctx.i, "borongan.pay")) return "Anda tidak berwenang";
        if (await guardDup(s, v, { direction: "KELUAR", amount: Number(d.total), date: new Date(), accountId: String(d.bankId), text: `upah borongan ${d.pointName ?? ""}` })) return null;
        try {
          const st = await settlePoint({ pointId: String(d.pointId), upTo: dateOnly(todayStr()), bankAccountId: String(d.bankId) }, actorOf(ctx.i));
          d.number = st.number;
          d.total = Number(st.total);
        } catch (e) {
          return errMsg(e);
        }
        return "done";
    }
    return null;
  },
  async finish(_ctx, s) {
    return { text: `✅ <b>Upah ${esc(String(s.data.number))} dibayar</b>\n${esc(String(s.data.pointName))}: ${idr(Number(s.data.total))} dari ${esc(String(s.data.bankName))}`, buttons: [[{ text: "💰 Upah lain", callback_data: "f:start:bupah" }, ...menuBtn]] };
  },
};

// =====================================================================
// Angsuran hutang supplier / cicilan pinjaman (dari pesan atau foto bukti transfer)
// =====================================================================
export type PayablePrefill = { candidates: string[]; amount: number | null; bankId: string | null; date: string | null; time: string | null; note: string | null; proofPath: string | null; tx: unknown };

/** Mulai isian bayar hutang yang sudah terisi dari pesan/bukti transfer */
export async function prefilledPayablePayment(ctx: Ctx, p: PayablePrefill): Promise<Session | null> {
  if (!can(ctx.i, "accounting.post", "finance.approve")) return null;
  const bank = p.bankId ? await prisma.bankAccount.findUnique({ where: { id: p.bankId } }) : null;
  const s: Session = {
    chatId: ctx.chatId,
    userId: ctx.i.userId,
    flow: "utang",
    step: "pick",
    data: { page: 0, cands: p.candidates.length ? JSON.stringify(p.candidates) : null, amount: p.amount, bankId: bank?.id ?? null, bankName: bank?.name ?? null, date: p.date, time: p.time, note: p.note ? p.note.slice(0, 200) : null, proofPath: p.proofPath, tx: JSON.stringify(p.tx) },
  };
  if (p.candidates.length === 1) await pickPayable(s, p.candidates[0]);
  s.step = nextPayStep(s);
  return s;
}

async function pickPayable(s: Session, id: string) {
  const p = await prisma.payable.findUnique({ where: { id }, include: { supplier: { select: { name: true } } } });
  if (!p || p.paid >= p.amount) return false;
  s.data.payId = p.id;
  s.data.payKind = p.kind;
  s.data.payName = `${p.number} · ${p.supplier?.name ?? p.vendor}`;
  s.data.remaining = Number(p.amount - p.paid);
  s.data.plan = JSON.stringify({ amount: Number(p.amount), paid: Number(p.paid), installments: p.installments, interestTotal: p.interestTotal == null ? null : Number(p.interestTotal) });
  s.data.next = nextInstallment(p)?.total ?? null;
  s.data.interest = null;
  return true;
}

/** Pokok & bunga dari nominal transfer (bunga dari jadwal cicilan bila nominalnya sama, atau yang diketik pengguna) */
function paySplit(d: Session["data"]) {
  if (!d.amount || !d.plan) return { principal: Number(d.amount ?? 0), interest: 0 };
  return splitPayment(JSON.parse(String(d.plan)), Number(d.amount), d.interest == null ? null : Number(d.interest));
}

function nextPayStep(s: Session) {
  const d = s.data;
  if (!d.payId) return "pick";
  const sp = paySplit(d);
  if (!d.amount || sp.principal <= 0 || sp.principal > Number(d.remaining)) return "amt";
  if (!d.bankId) return "bank";
  return "confirm";
}

const payDebt: FlowDef = {
  async start(ctx) {
    if (!can(ctx.i, "accounting.post", "finance.approve")) return "Anda tidak berwenang mencatat pembayaran hutang";
    return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "utang", step: "pick", data: { page: 0 } };
  },
  async prompt(s) {
    const d = s.data;
    const rem = Number(d.remaining ?? 0);
    const sp = paySplit(d);
    const loan = d.payKind === "PINJAMAN";
    const head = [
      "<b>💳 Bayar hutang / cicilan pinjaman</b>",
      d.payName ? `${loan ? "Pinjaman" : "Hutang"}: ${esc(String(d.payName))}\nSisa pokok sebelum bayar: ${idr(rem)}` : "",
      d.next ? `Cicilan terjadwal: ${idr(Number(d.next))}` : "",
      d.amount ? `Dibayar: <b>${idr(Number(d.amount))}</b>${sp.interest ? ` (pokok ${idr(sp.principal)} + bunga/biaya ${idr(sp.interest)})` : ""}${rem ? ` · sisa setelah ini ${idr(Math.max(0, rem - sp.principal))}` : ""}` : "",
      d.bankName ? `Dari rekening: ${esc(String(d.bankName))}` : "",
      d.date && d.date !== todayStr() ? `Tanggal: ${fmtDate(dateOnly(String(d.date)))}` : "",
      d.tx ? "<i>Dikenali dari pesan/bukti transfer sebagai pembayaran hutang.</i>" : "",
    ].filter(Boolean).join("\n");
    const plainRow: InlineButton[][] = d.tx ? [[{ text: "📝 Bukan bayar hutang, catat transaksi biasa", callback_data: "f:plain" }]] : [];
    switch (s.step) {
      case "pick": {
        const cands: string[] = d.cands ? JSON.parse(String(d.cands)) : [];
        const rows = await prisma.payable.findMany({ where: cands.length ? { id: { in: cands } } : {}, include: { supplier: { select: { name: true } } }, orderBy: { date: "desc" }, take: 100 });
        const open = rows.filter((p) => p.paid < p.amount).slice(0, 12);
        if (!open.length) return { text: `${head}\n\nTidak ada hutang yang belum lunas.`, buttons: [...plainRow, cancelRow] };
        return { text: `${head}\n\nPilih hutang / pinjaman yang dibayar:`, buttons: [...open.map((p) => [{ text: `${p.kind === "PINJAMAN" ? "🏦" : "📦"} ${p.number} · ${(p.supplier?.name ?? p.vendor).slice(0, 18)} · sisa ${idr(Number(p.amount - p.paid))}`.slice(0, 60), callback_data: `f:${p.id}` }]), ...(cands.length ? [[{ text: "📋 Lihat semua hutang", callback_data: "f:all" }]] : []), ...plainRow, cancelRow] };
      }
      case "amt":
        return { text: `${head}\n\n✍️ Ketik nominal yang ditransfer (pokok maks. ${idr(rem)}), contoh <code>2000000</code> atau <code>2jt</code>`, buttons: [...(d.next ? [[{ text: `Cicilan (${idr(Number(d.next))})`, callback_data: "f:inst" }]] : []), [{ text: `Lunasi (${idr(rem)})`, callback_data: "f:full" }], ...plainRow, cancelRow] };
      case "int":
        return { text: `${head}\n\n✍️ Ketik bunga/biaya yang termasuk dalam nominal ini (0 bila tidak ada)`, buttons: [[{ text: "Tanpa bunga (0)", callback_data: "f:0" }], cancelRow] };
      case "bank":
        return { text: `${head}\nDibayar dari rekening:`, buttons: [...(await bankButtons()), ...plainRow, cancelRow] };
      case "confirm":
        return { text: `${head}\n\nSimpan pembayaran ini? Tercatat di Transaksi, jurnal langsung dibukukan dan sisa hutang berkurang.`, buttons: [[{ text: "✅ Simpan", callback_data: "f:ok" }], [{ text: "✏️ Ubah nominal", callback_data: "f:editamt" }, { text: "✏️ Bunga", callback_data: "f:editint" }], ...plainRow, [{ text: "❌ Batal", callback_data: "f:x" }]] };
    }
    return { text: head };
  },
  async answer(ctx, s, v, fromText) {
    const d = s.data;
    switch (s.step) {
      case "pick":
        if (fromText) return "Pilih hutang dengan tombol";
        if (v === "all") {
          d.cands = null;
          return null;
        }
        if (!(await pickPayable(s, v))) return "Hutang tidak ditemukan atau sudah lunas";
        s.step = nextPayStep(s);
        return null;
      case "amt": {
        const n = !fromText && v === "full" ? Number(d.remaining) : !fromText && v === "inst" ? Number(d.next) : parseIDR(v);
        if (!n || n <= 0) return "Nominal tidak valid";
        d.amount = n;
        d.interest = null;
        if (paySplit(d).principal > Number(d.remaining)) return `Pokok melebihi sisa hutang ${idr(Number(d.remaining))}. Bila ada bunga, tekan ✏️ Bunga setelah ini.`;
        s.step = nextPayStep(s);
        return null;
      }
      case "int": {
        const n = !fromText ? Number(v) : parseIDR(v) ?? (v.trim() === "0" ? 0 : NaN);
        if (!Number.isFinite(n) || n < 0 || n >= Number(d.amount)) return "Bunga harus 0 – kurang dari nominal";
        d.interest = n;
        if (paySplit(d).principal > Number(d.remaining)) return `Pokok masih melebihi sisa hutang ${idr(Number(d.remaining))}`;
        s.step = nextPayStep(s);
        return null;
      }
      case "bank": {
        const b = fromText ? null : await prisma.bankAccount.findUnique({ where: { id: v } });
        if (!b) return "Pilih rekening dengan tombol";
        d.bankId = b.id;
        d.bankName = b.name;
        s.step = nextPayStep(s);
        return null;
      }
      case "confirm": {
        if (v === "editamt") {
          s.step = "amt";
          return null;
        }
        if (v === "editint") {
          s.step = "int";
          return null;
        }
        if (v !== "ok") return "Tekan Simpan atau Batal";
        if (!can(ctx.i, "accounting.post", "finance.approve")) return "Anda tidak berwenang";
        if (await guardDup(s, v, { direction: "KELUAR", amount: Number(d.amount), date: jakartaDateTime(d.date ? String(d.date) : todayStr(), d.time ? String(d.time) : "12:00"), accountId: String(d.bankId), text: `${d.payName ?? ""} ${d.note ?? ""}` })) return null;
        try {
          const tx = d.tx ? (JSON.parse(String(d.tx)) as { messageId?: string; rawText?: string; proofPath?: string | null; aiExtraction?: object; note?: string | null }) : null;
          const sp = paySplit(d);
          const r = await bookPayablePayment(
            {
              payableId: String(d.payId),
              amount: Number(d.amount),
              interest: sp.interest,
              bankAccountId: String(d.bankId),
              date: jakartaDateTime(d.date ? String(d.date) : todayStr(), d.time ? String(d.time) : "12:00"),
              note: d.note ? String(d.note) : null,
              rawText: tx?.rawText ?? null,
              proofPath: d.proofPath ? String(d.proofPath) : tx?.proofPath ?? null,
              proofMime: d.proofPath || tx?.proofPath ? "image/jpeg" : null,
              aiExtraction: tx?.aiExtraction ?? null,
              idempotencyKey: tx?.messageId ? `tg:${ctx.chatId}:${tx.messageId}` : null,
              telegramChatId: ctx.chatId,
              telegramMessageId: tx?.messageId ?? null,
            },
            "TELEGRAM",
            actorOf(ctx.i),
          );
          d.remaining = r.remaining;
          d.txNumber = r.transaction.number;
          d.principal = r.principal;
          d.interest = r.interest;
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
    const rem = Number(d.remaining);
    return { text: `✅ <b>Pembayaran ${d.payKind === "PINJAMAN" ? "cicilan pinjaman" : "hutang"} tercatat</b> (${esc(String(d.txNumber))})\n${esc(String(d.payName))}\nDibayar ${idr(Number(d.amount))} dari ${esc(String(d.bankName))}${Number(d.interest) ? `\nPokok ${idr(Number(d.principal))} · bunga/biaya ${idr(Number(d.interest))}` : ""}\n${rem > 0 ? `Sisa hutang: <b>${idr(rem)}</b>` : "Hutang sudah <b>lunas</b> 🎉"}`, buttons: [menuBtn] };
  },
};

// =====================================================================
// Dana sisihan dari bukti transfer (dikenali dari nominal & rekening)
// =====================================================================
type ReserveOpt = { fundIds: string[]; dates: string[]; amount: number; label: string; parts?: ReservePart[] };
const fmtDates = (ds: string[]) => ds.map((x) => fmtDate(dateOnly(x))).join(", ");

/** Mulai konfirmasi sisihan dari bukti transfer. `sure` = langsung ke konfirmasi; selain itu pilih dananya */
export async function prefilledReserve(ctx: Ctx, p: { options: ReserveOpt[]; sure: boolean; proofPath: string | null; tx: unknown }): Promise<Session | null> {
  if (!can(ctx.i, "finance.approve") || !p.options.length) return null;
  return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "sish", step: p.sure ? "confirm" : "pick", data: { opts: JSON.stringify(p.options), pick: p.sure ? 0 : null, proofPath: p.proofPath, tx: JSON.stringify(p.tx) } };
}

const reserveFromProof: FlowDef = {
  async start() {
    return "Kirim foto bukti transfer sisihan, nanti saya cocokkan dengan dana sisihan.";
  },
  async prompt(s) {
    const d = s.data;
    const opts: ReserveOpt[] = JSON.parse(String(d.opts ?? "[]"));
    const plainRow: InlineButton[][] = d.tx ? [[{ text: "📝 Bukan sisihan, catat transaksi biasa", callback_data: "f:plain" }]] : [];
    const head = `<b>🏦 Dana sisihan</b>\nBukti transfer ${idr(opts[0]?.amount ?? 0)}${d.proofPath ? " (foto dilampirkan)" : ""}`;
    if (s.step === "pick") {
      return { text: `${head}\n\nNominal ini cocok dengan beberapa dana sisihan. Untuk dana yang mana?`, buttons: [...opts.map((o, k) => [{ text: `${o.label} (${o.dates.map((x) => x.slice(8)).join(",")})`.slice(0, 60), callback_data: `f:o${k}` }]), ...plainRow, cancelRow] };
    }
    const o = opts[Number(d.pick ?? 0)];
    const funds = await prisma.reserveFund.findMany({ where: { id: { in: o.fundIds } } });
    const done = await prisma.reserveEntry.findMany({ where: { fundId: { in: o.fundIds }, type: "SISIH", date: { in: o.dates.map((x) => dateOnly(x)) } } });
    const already = done.length === o.fundIds.length * o.dates.length;
    const tx0 = d.tx ? (JSON.parse(String(d.tx)) as { amount: number; date: string; accountId: string | null; toAccountId?: string | null }) : null;
    const bks = tx0 ? await prisma.bankAccount.findMany({ where: { id: { in: [tx0.accountId, tx0.toAccountId].filter((x): x is string => !!x) } } }) : [];
    const bankName = (id: string | null | undefined) => bks.find((b) => b.id === id)?.name ?? "—";
    return {
      text: `${head}\n\n${o.label.startsWith("Sisihan ") ? `Dikenali sebagai <b>${esc(o.label)}</b>\nDana: ${esc(funds.map((f) => f.name).join(" + "))}` : `Dikenali sebagai sisihan <b>${esc(funds.map((f) => f.name).join(" + "))}</b>`}\nTanggal sisihan: ${fmtDates(o.dates)}${tx0 ? `\nTransfer: ${idr(tx0.amount)} · ${fmtDateTime(new Date(tx0.date))} · ${esc(bankName(tx0.accountId))} → ${esc(bankName(tx0.toAccountId))}` : ""}\n${d.tx && o.parts?.length ? "Transfer dicatat di Transaksi dan langsung dibukukan; sisihannya tercatat dengan bukti transfer ini." + (done.length ? " Sisihan tanggal tsb yang sudah dicatat tanpa bukti memakai transfer ini (tidak dobel)." : "") : already ? "Sisihan tanggal tsb sudah tercatat, bukti transfer akan dilampirkan (tidak ada jurnal baru)." : done.length ? "Sebagian sudah tercatat: yang sudah hanya dilampiri bukti, sisanya dicatat sekarang." : "Sisihan akan dicatat dan bukti transfer dilampirkan."}\n\nBenar?`,
      buttons: [[{ text: "✅ Benar, simpan", callback_data: "f:ok" }], ...(opts.length > 1 ? [[{ text: "🔁 Pilih dana lain", callback_data: "f:pick" }]] : []), ...plainRow, [{ text: "❌ Batal", callback_data: "f:x" }]],
    };
  },
  async answer(ctx, s, v, fromText) {
    const d = s.data;
    if (fromText) return "Pilih dengan tombol";
    if (s.step === "pick") {
      const k = Number(v.replace(/^o/, ""));
      const opts: ReserveOpt[] = JSON.parse(String(d.opts ?? "[]"));
      if (!opts[k]) return "Pilihan tidak dikenal";
      d.pick = k;
      s.step = "confirm";
      return null;
    }
    if (v === "pick") {
      s.step = "pick";
      return null;
    }
    if (v !== "ok") return "Tekan Simpan atau Batal";
    if (!can(ctx.i, "finance.approve")) return "Anda tidak berwenang";
    const opts: ReserveOpt[] = JSON.parse(String(d.opts ?? "[]"));
    {
      // Transfer sisihan yang sama dikirim/dicatat dua kali: cek transfer mirip & tanggal sisihan yang sudah berbukti
      const o = opts[Number(d.pick ?? 0)];
      const tx = d.tx ? (JSON.parse(String(d.tx)) as { amount: number; date: string; accountId: string | null; note: string | null; rawText: string }) : null;
      const fund = o ? await prisma.reserveFund.findUnique({ where: { id: o.fundIds[0] } }) : null;
      if (o && (await guardDup(s, v, { direction: "TRANSFER", amount: tx?.amount ?? o.amount, date: tx ? new Date(tx.date) : new Date(), accountId: tx?.accountId ?? fund?.fromBankId ?? null, toAccountId: fund?.toBankId ?? null, text: [tx?.note, tx?.rawText].filter(Boolean).join(" "), reserveParts: o.parts ?? o.fundIds.flatMap((fundId) => o.dates.map((date) => ({ fundId, date }))) }))) return null;
    }
    try {
      const o = opts[Number(d.pick ?? 0)];
      const tx = d.tx ? (JSON.parse(String(d.tx)) as { amount: number; date: string; accountId: string | null; note: string | null; rawText: string; proofPath: string | null; aiExtraction: unknown; messageId: string }) : null;
      if (tx && o.parts?.length) {
        // Transfer sisihan = transaksi transfer (dengan bukti) yang dibukukan bersama sisihannya: tampil di Transaksi & Dana sisihan
        const r = await bookReserveTransfer(
          {
            direction: "TRANSFER",
            amount: tx.amount,
            date: new Date(tx.date),
            accountId: tx.accountId,
            note: tx.note,
            rawText: tx.rawText,
            proofPath: tx.proofPath,
            proofMime: tx.proofPath ? "image/jpeg" : null,
            aiExtraction: tx.aiExtraction as object,
            idempotencyKey: `tg:${ctx.chatId}:${tx.messageId}`,
            telegramChatId: ctx.chatId,
            telegramMessageId: tx.messageId,
            dupAckIds: ackIds(s),
          },
          o.parts,
          "TELEGRAM",
          actorOf(ctx.i),
        );
        d.txNumber = r.transaction.number;
        d.txId = r.transaction.id;
        d.booked = r.booked ? 1 : 0;
        d.posted = r.booked ? o.parts.length : 0;
        d.attached = 0;
      } else {
        const r = await applyReserveOption(o, d.proofPath ? { path: String(d.proofPath), mime: "image/jpeg" } : null, actorOf(ctx.i));
        d.posted = r.posted;
        d.attached = r.attached;
      }
    } catch (e) {
      return e instanceof FinanceError ? e.message : errMsg(e);
    }
    return "done";
  },
  async finish(_ctx, s) {
    const d = s.data;
    const o: ReserveOpt = JSON.parse(String(d.opts))[Number(d.pick ?? 0)];
    if (d.txNumber && !Number(d.booked)) return pendingCard(String(d.txId), `⚠️ <b>Transfer dicatat sebagai ${esc(String(d.txNumber))}</b> tapi belum dibukukan (data kurang atau mirip transaksi lain). Lanjutkan di kartu ini; sisihannya ikut tercatat saat dibukukan.`);
    return { text: `✅ <b>Sisihan tersimpan</b>${d.txNumber ? ` (${esc(String(d.txNumber))})` : ""}\n${esc(o.label)} · ${fmtDates(o.dates)}\n${d.txNumber ? "Transfer tercatat di Transaksi dan bukti transfer terlampir di Dana sisihan." : `${Number(d.posted) ? `${d.posted} sisihan baru dicatat. ` : ""}${Number(d.attached) ? `Bukti dilampirkan ke ${d.attached} sisihan yang sudah ada.` : ""}`}`, buttons: [menuBtn] };
  },
};


// =====================================================================
// Pengembalian dana talangan (Seabank 0006 / ShopeePay dipakai operasional)
// =====================================================================
const tlgHead = "<b>💸 Pengembalian dana talangan</b>";

/** Mulai isian pengembalian langsung ke langkah konfirmasi (bukti transfer sudah dikirim) */
export async function prefilledTalangan(ctx: Ctx, p: { walletId: string; proofPath: string | null; read: number | null; messageId?: string; date?: string | null }): Promise<Session | null> {
  if (!can(ctx.i, "finance.approve")) return null;
  const w = (await talanganSummary()).find((x) => x.bank.id === p.walletId && x.outstanding > 0);
  if (!w) return null;
  return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "tlg", step: "confirm", data: { walletId: w.bank.id, amount: w.outstanding, proofPath: p.proofPath, read: p.read, msgId: p.messageId ?? null, date: p.date ?? null } };
}

/** Foto bukti dikirim saat isian menunggu bukti: simpan, baca nominalnya, lanjut konfirmasi */
export async function talanganPhoto(ctx: Ctx, s: Session, photo: Buffer, messageId: string) {
  s.data.proofPath = await saveProof(photo, "image/jpeg");
  s.data.read = await readProofAmount(photo, "image/jpeg");
  s.data.msgId = messageId;
  s.step = "confirm";
  return s;
}

const talangan: FlowDef = {
  async start(ctx) {
    if (!can(ctx.i, "finance.approve")) return "Anda tidak berwenang";
    const open = (await talanganSummary()).filter((w) => w.outstanding > 0);
    if (!open.length) return "✅ Tidak ada dana talangan yang perlu dikembalikan.";
    return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "tlg", step: open.length > 1 ? "pick" : "proof", data: { walletId: open.length > 1 ? null : open[0].bank.id, amount: open.length > 1 ? null : open[0].outstanding } };
  },
  async prompt(s) {
    const d = s.data;
    const all = await talanganSummary();
    if (s.step === "pick") {
      const open = all.filter((w) => w.outstanding > 0);
      return { text: `${tlgHead}
Pilih rekening simpanan yang dikembalikan:`, buttons: [...open.map((w) => [{ text: `${w.bank.name} · ${idr(w.outstanding)}`.slice(0, 60), callback_data: `f:${w.bank.id}` }]), cancelRow] };
    }
    const w = all.find((x) => x.bank.id === d.walletId);
    if (!w) return { text: `${tlgHead}
Rekening tidak ditemukan.`, buttons: [cancelRow] };
    const rows = w.open.slice(0, 10).map((i) => `• ${fmtDate(i.date)} · ${esc(i.label)} ${esc(i.ref)} · ${idr(i.amount)}`).join("\n");
    const head = `${tlgHead}\n${esc(w.bank.name)}: <b>${idr(w.outstanding)}</b>\n${rows}${w.open.length > 10 ? `\n… ${w.open.length - 10} lainnya` : ""}`;
    if (s.step === "proof") return { text: `${head}\n\nTransfer <b>${idr(w.outstanding)}</b> dari ${esc(w.fromBank?.name ?? "rekening operasional")} ke ${esc(w.bank.name)}, lalu <b>kirim foto bukti transfernya</b> di sini.`, buttons: [cancelRow] };
    const read = d.read ? Number(d.read) : null;
    const amount = Number(d.amount ?? w.outstanding);
    const check = read == null ? "Nominal di foto tidak terbaca, pastikan sama." : read === amount ? `Nominal di bukti cocok: ${idr(read)} ✓` : `⚠️ Nominal di bukti terbaca ${idr(read)}, tidak sama dengan total talangan ${idr(amount)}.`;
    return {
      text: `${head}\n\nBukti transfer diterima. ${check}\n\nSimpan pengembalian <b>${idr(read && read !== amount && read < amount ? read : amount)}</b> dari ${esc(w.fromBank?.name ?? "rekening operasional")} ke ${esc(w.bank.name)}?`,
      buttons: [[{ text: "✅ Simpan", callback_data: "f:ok" }], [{ text: "📷 Kirim ulang bukti", callback_data: "f:again" }], cancelRow],
    };
  },
  async answer(ctx, s, v, fromText) {
    const d = s.data;
    if (s.step === "pick") {
      if (fromText) return "Pilih dengan tombol";
      const w = (await talanganSummary()).find((x) => x.bank.id === v && x.outstanding > 0);
      if (!w) return "Pilihan tidak dikenal";
      d.walletId = w.bank.id;
      d.amount = w.outstanding;
      s.step = "proof";
      return null;
    }
    if (s.step === "proof") return fromText ? "Kirim FOTO bukti transfer (bukan teks)" : "Kirim foto bukti transfer";
    if (v === "again") {
      s.step = "proof";
      return null;
    }
    if (v !== "ok") return "Tekan Simpan atau Batal";
    if (!can(ctx.i, "finance.approve")) return "Anda tidak berwenang";
    const read = d.read ? Number(d.read) : null;
    const w = (await talanganSummary()).find((x) => x.bank.id === d.walletId);
    if (!w || w.outstanding <= 0) return "Talangan sudah dikembalikan";
    // Bukti lebih kecil dari total = pengembalian sebagian sebesar nominal di bukti; selain itu total talangan
    const amount = read && read < w.outstanding ? read : w.outstanding;
    if (await guardDup(s, v, { direction: "TRANSFER", amount, date: d.date ? jakartaDateTime(String(d.date), "12:00") : new Date(), accountId: w.fromBank?.id ?? null, toAccountId: w.bank.id, text: "pengembalian talangan" })) return null;
    try {
      const r = await repayTalangan(
        { walletId: w.bank.id, amount, date: d.date ? String(d.date) : todayStr(), proofPath: d.proofPath ? String(d.proofPath) : null, proofMime: d.proofPath ? "image/jpeg" : null, idempotencyKey: d.msgId ? `tg:${ctx.chatId}:${d.msgId}` : null, telegramChatId: ctx.chatId, telegramMessageId: d.msgId ? String(d.msgId) : null, dupAckIds: ackIds(s) },
        "TELEGRAM",
        actorOf(ctx.i),
      );
      d.txNumber = r.transaction.number;
      d.txId = r.transaction.id;
      d.booked = r.booked ? 1 : 0;
      d.paid = amount;
      d.remaining = Math.max(0, w.outstanding - amount);
    } catch (e) {
      return e instanceof FinanceError ? e.message : errMsg(e);
    }
    return "done";
  },
  async finish(_ctx, s) {
    const d = s.data;
    if (!Number(d.booked)) return pendingCard(String(d.txId), `⚠️ Pengembalian tercatat sebagai ${esc(String(d.txNumber))} tapi belum dibukukan (data kurang atau mirip transaksi lain). Lanjutkan di kartu ini.`);
    return { text: `✅ <b>Pengembalian talangan dibukukan</b> (${esc(String(d.txNumber))})\n${idr(Number(d.paid))} · bukti terlampir\n${Number(d.remaining) > 0 ? `Sisa talangan: <b>${idr(Number(d.remaining))}</b>` : "Talangan rekening ini sudah lunas 🎉"}`, buttons: [menuBtn] };
  },
};

/** Transaksi yang belum bisa dibukukan: tampilkan kartu draft bertombol (lanjut di bot, tidak buntu) */
async function pendingCard(txId: string, head: string): Promise<Prompt> {
  const m = await draftMessage(txId);
  return { text: `${head}\n\n${m.text}`, buttons: [...m.buttons, menuBtn] };
}

// =====================================================================
// Draft transaksi biasa yang mirip transaksi lain: ditanyakan dulu sebelum disimpan
// =====================================================================
const draftDup: FlowDef = {
  async start() {
    return "Kirim pesan atau foto bukti transaksi.";
  },
  async prompt(s) {
    const tx = JSON.parse(String(s.data.tx ?? "{}")) as DraftInput;
    return { text: `📝 Simpan sebagai draft transaksi ${idr(tx.amount ?? 0)}?`, buttons: [[{ text: "✅ Simpan draft", callback_data: "f:ok" }], cancelRow] };
  },
  async answer(ctx, s, v, fromText) {
    if (fromText || v !== "ok") return "Tekan Simpan draft atau Batal";
    const tx = JSON.parse(String(s.data.tx)) as DraftInput;
    await createDraft(ctx.chatId, ctx.i, { ...tx, dupAckIds: ackIds(s) });
    return "done";
  },
  async finish() {
    return { text: "✅ Disimpan sebagai draft (lihat kartu draft di bawah)." };
  },
};

export const T3_FLOWS: Record<string, FlowDef> = { trx: draftDup, kas: kasbon, ksb: giveKasbon, beli: purchase, utang: payDebt, sish: reserveFromProof, tlg: talangan, bor: boronganMenu, bter: receive, bset: result, bkir: sendGoods, bupah: unpaid, bbay: pay, ...SALES_FLOWS };
