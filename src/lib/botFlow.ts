import type { MovementType, Prisma, ProductionStage } from "@prisma/client";
import { prisma } from "./db";
import type { Permission } from "./rbac";
import { audit } from "./audit";
import { recordMovement, stockBalances, StockError, STAGES, STAGE_LABEL, MOVEMENT_LABEL } from "./stock";
import { REJECT_REASONS } from "./reject";
import { EntryForbidden, recordProductionEntry } from "./productionEntry";
import { selfCheckIn, selfCheckOut } from "./attendanceSelf";
import { ATT_LABEL, type GeoPoint } from "./attendance";
import { idr } from "./money";
import { addDays, dateOnly, fmtDate, fmtDateTime, jakartaDateTime, todayStr } from "./time";
import { answerCallback, editTelegram, esc, sendTelegram, type InlineButton } from "./telegram";
import type { BotIdent } from "./botMenu";
import { cancelRow, can, chunk, fmtQty, itemChoices, itemPrompt, MENU_TEXT, PAGE, pager, parseCount, parseQty, userDivision, type Ctx, type Data, type Prompt, type Session } from "./botKit";
export { parseCount, parseQty } from "./botKit";
import { T3_FLOWS, t3MenuRows } from "./botFlow3";

/**
 * Isian bertahap di bot Telegram (Tahap 2): input hasil produksi + reject, absen dengan lokasi,
 * mutasi stok, permintaan stok, dan cek stok. Status isian disimpan di tabel BotSession (per chat),
 * jadi aman bila server dimulai ulang. Tombol berawalan "f:"; teks/lokasi dibaca selama sesi aktif.
 */

export const FLOW_TTL_MIN = 30;


// ---------- Sesi ----------
export async function getSession(chatId: string): Promise<Session | null> {
  const s = await prisma.botSession.findUnique({ where: { chatId } });
  if (!s) return null;
  if (Date.now() - s.updatedAt.getTime() > FLOW_TTL_MIN * 60_000) {
    await prisma.botSession.delete({ where: { chatId } }).catch(() => {});
    return null;
  }
  return { ...s, data: (s.data ?? {}) as Data };
}

async function save(s: Session) {
  const data = s.data as Prisma.InputJsonValue;
  await prisma.botSession.upsert({ where: { chatId: s.chatId }, create: { chatId: s.chatId, userId: s.userId, flow: s.flow, step: s.step, data }, update: { userId: s.userId, flow: s.flow, step: s.step, data } });
}

export async function clearSession(chatId: string) {
  await prisma.botSession.delete({ where: { chatId } }).catch(() => {});
}

/** Dipakai webhook: pesan teks/lokasi saat isian aktif selalu ditangani ERP (tidak diteruskan ke Hermes) */
export async function hasActiveFlow(chatId: string) {
  return !!(await getSession(chatId));
}

async function present(ctx: Ctx, p: Prompt) {
  if (p.replyKeyboard) {
    await sendTelegram(ctx.chatId, p.text, { replyMarkup: { keyboard: p.replyKeyboard, resize_keyboard: true, one_time_keyboard: true }, type: "ISIAN" });
    if (p.buttons?.length) await sendTelegram(ctx.chatId, "Atau batalkan:", { buttons: p.buttons, type: "ISIAN" });
    return;
  }
  if (ctx.messageId) {
    const r = await editTelegram(ctx.chatId, ctx.messageId, p.text, p.buttons ?? []);
    if (r.ok) return;
  }
  await sendTelegram(ctx.chatId, p.text, { buttons: p.buttons, type: "ISIAN" });
}

/** Kembalikan tombol 📋 Menu di bawah kolom chat (setelah tombol kirim lokasi) */
async function restoreKeyboard(chatId: string, text: string) {
  await sendTelegram(chatId, text, { keyboard: [[MENU_TEXT]], type: "ISIAN" });
}



// ---------- Menu fitur Tahap 2 ----------
export function inputMenuRows(i: BotIdent): InlineButton[][] {
  const rows: InlineButton[][] = [];
  const top: InlineButton[] = [];
  if (can(i, "attendance.self") && i.user.employeeId) top.push({ text: "📍 Absen", callback_data: "f:start:absen" });
  if (can(i, "production.create")) top.push({ text: "🏭 Input produksi", callback_data: "f:start:prod" });
  if (top.length) rows.push(top);
  if (can(i, "stock.move", "stock.request", "stock.view")) rows.push([{ text: "📦 Stok", callback_data: "f:start:stok" }]);
  rows.push(...t3MenuRows(i));
  return rows;
}

function stockMenu(i: BotIdent): Prompt {
  const rows: InlineButton[][] = [];
  if (can(i, "stock.view")) rows.push([{ text: "🔎 Cek stok", callback_data: "f:start:cek" }]);
  if (can(i, "stock.move")) rows.push([{ text: "🔁 Mutasi stok", callback_data: "f:start:mut" }]);
  if (can(i, "stock.request")) rows.push([{ text: "📝 Permintaan stok", callback_data: "f:start:req" }]);
  rows.push([{ text: "⬅ Kembali", callback_data: "m:home" }]);
  return { text: "<b>📦 Stok</b>\nPilih menu:", buttons: rows };
}

// =====================================================================
// Input produksi
// =====================================================================
async function prodStart(ctx: Ctx): Promise<Session | string> {
  const { i } = ctx;
  if (!can(i, "production.create")) return "Anda tidak berwenang input produksi";
  const s: Session = { chatId: ctx.chatId, userId: i.userId, flow: "prod", step: "", data: {} };
  if (i.user.role === "OPERATOR") {
    if (!i.user.employeeId) return "Akun Anda belum ditautkan ke data karyawan";
    const emp = await prisma.employee.findUniqueOrThrow({ where: { id: i.user.employeeId } });
    s.data = { employeeId: emp.id, employeeName: emp.name, divisionId: emp.divisionId };
    s.step = "date";
  } else if (i.user.role === "KAPTEN_DIVISI") {
    const div = await userDivision(i);
    if (!div) return "Akun kapten belum punya divisi";
    s.data = { divisionId: div };
    s.step = "emp";
  } else s.step = "div";
  return s;
}

async function prodPrompt(s: Session): Promise<Prompt> {
  const d = s.data;
  const head = "<b>🏭 Input produksi</b>\n" + [d.employeeName ? `Karyawan: ${esc(String(d.employeeName))}` : "", d.date ? `Tanggal: ${fmtDate(dateOnly(String(d.date)))}` : "", d.shiftName ? `Shift: ${esc(String(d.shiftName))}` : "", d.stage ? `Tahap: ${STAGE_LABEL[d.stage as ProductionStage]}` : "", d.productName ? `Produk: ${esc(String(d.productName))}` : "", d.qtyGood != null ? `Hasil baik: ${d.qtyGood} pcs` : "", d.qtyReject != null ? `Reject: ${d.qtyReject} pcs${d.rejectReason ? ` (${esc(String(d.rejectReason))})` : ""}` : ""].filter(Boolean).join("\n");
  const page = Number(d.page ?? 0);
  switch (s.step) {
    case "div": {
      const divs = await prisma.division.findMany({ where: { active: true }, orderBy: { code: "asc" } });
      return { text: `${head}\nPilih divisi:`, buttons: [...chunk(divs.map((x) => ({ text: x.name, callback_data: `f:${x.id}` })), 2), cancelRow] };
    }
    case "emp": {
      const emps = await prisma.employee.findMany({ where: { status: "AKTIF", divisionId: String(d.divisionId) }, orderBy: { name: "asc" }, skip: page * PAGE, take: PAGE + 1 });
      if (!emps.length && page === 0) return { text: `${head}\nBelum ada karyawan aktif di divisi ini.`, buttons: [cancelRow] };
      return { text: `${head}\nPilih karyawan:`, buttons: [...chunk(emps.slice(0, PAGE).map((x) => ({ text: x.name.slice(0, 30), callback_data: `f:${x.id}` })), 2), ...pager(page, emps.length > PAGE), cancelRow] };
    }
    case "date":
      return { text: `${head}\nTanggal produksi:`, buttons: [[{ text: "Hari ini", callback_data: "f:0" }, { text: "Kemarin", callback_data: "f:-1" }], cancelRow] };
    case "shift": {
      const shifts = await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } });
      return { text: `${head}\nPilih shift:`, buttons: [...chunk(shifts.map((x) => ({ text: x.name, callback_data: `f:${x.id}` })), 2), cancelRow] };
    }
    case "stage":
      return { text: `${head}\nPilih tahap:`, buttons: [...chunk(STAGES.map((x) => ({ text: STAGE_LABEL[x], callback_data: `f:${x}` })), 3), cancelRow] };
    case "prod": {
      const prods = await prisma.product.findMany({ where: { active: true }, orderBy: { name: "asc" }, skip: page * PAGE, take: PAGE + 1 });
      return { text: `${head}\nPilih produk:`, buttons: [...chunk(prods.slice(0, PAGE).map((x) => ({ text: x.name.slice(0, 32), callback_data: `f:${x.id}` })), 2), ...pager(page, prods.length > PAGE), cancelRow] };
    }
    case "good":
      return { text: `${head}\n\n✍️ Ketik jumlah <b>hasil baik</b> (pcs), contoh: <code>120</code>`, buttons: [cancelRow] };
    case "rej":
      return { text: `${head}\n\n✍️ Ketik jumlah <b>reject</b> (pcs), atau tekan tombol bila tidak ada.`, buttons: [[{ text: "Tidak ada reject (0)", callback_data: "f:0" }], cancelRow] };
    case "reason":
      return { text: `${head}\nPilih penyebab reject:`, buttons: [...chunk(REJECT_REASONS.map((r, k) => ({ text: r, callback_data: `f:${k}` })), 2), cancelRow] };
    case "confirm":
      return { text: `${head}\n\nSimpan hasil produksi ini?`, buttons: [[{ text: "✅ Simpan", callback_data: "f:ok" }, { text: "❌ Batal", callback_data: "f:x" }]] };
  }
  return { text: head };
}

/** Proses jawaban (tombol/teks) untuk input produksi. Mengembalikan pesan galat atau null. */
async function prodAnswer(ctx: Ctx, s: Session, v: string, fromText: boolean): Promise<string | null | "done"> {
  const d = s.data;
  switch (s.step) {
    case "div": {
      if (fromText) return "Pilih divisi dengan tombol";
      const div = await prisma.division.findUnique({ where: { id: v } });
      if (!div) return "Divisi tidak ditemukan";
      d.divisionId = div.id;
      s.step = "emp";
      d.page = 0;
      return null;
    }
    case "emp": {
      if (fromText) return "Pilih karyawan dengan tombol";
      const e = await prisma.employee.findUnique({ where: { id: v } });
      if (!e || e.status !== "AKTIF") return "Karyawan tidak ditemukan / nonaktif";
      if (ctx.i.user.role === "KAPTEN_DIVISI" && e.divisionId !== d.divisionId) return "Karyawan di luar divisi Anda";
      d.employeeId = e.id;
      d.employeeName = e.name;
      s.step = "date";
      return null;
    }
    case "date": {
      if (fromText) return "Pilih tanggal dengan tombol";
      d.date = addDays(todayStr(), v === "-1" ? -1 : 0);
      const shifts = await prisma.shift.findMany({ where: { active: true } });
      if (shifts.length === 1) {
        d.shiftId = shifts[0].id;
        d.shiftName = shifts[0].name;
        s.step = "stage";
      } else s.step = "shift";
      return null;
    }
    case "shift": {
      const sh = await prisma.shift.findUnique({ where: { id: v } });
      if (fromText || !sh) return "Pilih shift dengan tombol";
      d.shiftId = sh.id;
      d.shiftName = sh.name;
      s.step = "stage";
      return null;
    }
    case "stage":
      if (fromText || !STAGES.includes(v as ProductionStage)) return "Pilih tahap dengan tombol";
      d.stage = v;
      s.step = "prod";
      d.page = 0;
      return null;
    case "prod": {
      const p = fromText ? null : await prisma.product.findUnique({ where: { id: v } });
      if (!p) return "Pilih produk dengan tombol";
      d.productId = p.id;
      d.productName = p.name;
      s.step = "good";
      return null;
    }
    case "good": {
      const n = parseCount(v);
      if (n == null || n > 100000) return "Ketik angka bulat, contoh 120";
      d.qtyGood = n;
      s.step = "rej";
      return null;
    }
    case "rej": {
      const n = parseCount(v);
      if (n == null || n > 100000) return "Ketik angka bulat, contoh 5, atau tekan Tidak ada reject";
      if (n + Number(d.qtyGood) === 0) return "Hasil baik dan reject tidak boleh sama-sama 0";
      d.qtyReject = n;
      d.rejectReason = null;
      s.step = n > 0 ? "reason" : "confirm";
      return null;
    }
    case "reason": {
      const r = REJECT_REASONS[Number(v)];
      if (fromText || !r) return "Pilih penyebab dengan tombol";
      d.rejectReason = r;
      s.step = "confirm";
      return null;
    }
    case "confirm": {
      if (v !== "ok") return "Tekan Simpan atau Batal";
      const div = d.divisionId ? String(d.divisionId) : (await prisma.employee.findUniqueOrThrow({ where: { id: String(d.employeeId) } })).divisionId;
      try {
        await recordProductionEntry(
          { date: String(d.date), shiftId: String(d.shiftId), divisionId: div, employeeId: String(d.employeeId), stage: String(d.stage), productId: String(d.productId), qtyGood: Number(d.qtyGood), qtyReject: Number(d.qtyReject), rejectReason: (d.rejectReason as (typeof REJECT_REASONS)[number]) ?? null, note: "Via Telegram" },
          { id: ctx.i.userId, name: ctx.i.user.name, role: ctx.i.user.role, employeeId: ctx.i.user.employeeId, divisionId: await userDivision(ctx.i) },
        );
      } catch (e) {
        return e instanceof EntryForbidden ? e.message : (e as Error).message.slice(0, 200);
      }
      return "done";
    }
  }
  return null;
}

// =====================================================================
// Absen
// =====================================================================
async function absenStatus(i: BotIdent) {
  if (!i.user.employeeId) return null;
  return prisma.attendance.findUnique({ where: { employeeId_date: { employeeId: i.user.employeeId, date: dateOnly(todayStr()) } }, include: { shift: true } });
}

async function absenStart(ctx: Ctx): Promise<Session | string | Prompt> {
  const { i } = ctx;
  if (!can(i, "attendance.self") || !i.user.employeeId) return "Akun Anda belum ditautkan ke data karyawan";
  const a = await absenStatus(i);
  if (a?.checkIn && a.checkOut) return { text: `<b>📍 Absen hari ini</b>\nMasuk: ${fmtDateTime(a.checkIn)}\nPulang: ${fmtDateTime(a.checkOut)}\n\n✅ Absen hari ini sudah lengkap.`, buttons: [[{ text: MENU_TEXT, callback_data: "m:home" }]] };
  if (a && !a.checkIn) return { text: `Status absensi hari ini: <b>${ATT_LABEL[a.status]}</b> (diatur admin). Hubungi atasan bila keliru.`, buttons: [[{ text: MENU_TEXT, callback_data: "m:home" }]] };
  return { chatId: ctx.chatId, userId: i.userId, flow: "absen", step: a?.checkIn ? "out" : "in", data: {} };
}

function absenPrompt(s: Session): Prompt {
  const masuk = s.step === "in";
  return {
    text: `<b>📍 Absen ${masuk ? "masuk" : "pulang"}</b>\nNyalakan GPS HP, lalu tekan tombol <b>📍 Kirim lokasi ${masuk ? "masuk" : "pulang"}</b> di bawah kolom chat.\n\nLokasi harus dikirim langsung dari HP (bukan diteruskan atau dipilih dari peta), dan berada di dalam area kerja.`,
    replyKeyboard: [[{ text: `📍 Kirim lokasi ${masuk ? "masuk" : "pulang"}`, request_location: true }], [{ text: MENU_TEXT }]],
    buttons: [cancelRow],
  };
}

export type TgLocation = { latitude: number; longitude: number; horizontal_accuracy?: number; live_period?: number };

/** Pesan lokasi dari Telegram saat sesi absen aktif */
export async function handleFlowLocation(i: BotIdent, chatId: string, loc: TgLocation, meta: { forwarded: boolean; venue: boolean; ageSec: number }) {
  const s = await getSession(chatId);
  if (!s || s.flow !== "absen" || s.userId !== i.userId) {
    await sendTelegram(chatId, "Untuk absen, buka 📋 Menu → 📍 Absen dulu, lalu kirim lokasi.");
    return;
  }
  if (meta.forwarded || meta.venue) return void (await sendTelegram(chatId, "❌ Lokasi harus dikirim langsung dengan tombol 📍 Kirim lokasi, bukan diteruskan atau dipilih dari peta."));
  if (meta.ageSec > 120) return void (await sendTelegram(chatId, "❌ Lokasi sudah kedaluwarsa. Tekan tombol 📍 Kirim lokasi lagi."));
  const pos: GeoPoint = { lat: loc.latitude, lng: loc.longitude, accuracy: loc.horizontal_accuracy ?? null };
  const actor = { id: i.userId, name: i.user.name, employeeId: i.user.employeeId };
  try {
    if (s.step === "in") {
      const r = await selfCheckIn(actor, pos, "TELEGRAM");
      await clearSession(chatId);
      await restoreKeyboard(chatId, `✅ <b>Absen masuk tercatat</b> (${esc(r.shift)})${r.status === "TERLAMBAT" ? `\n⚠️ Terlambat ${r.lateMinutes} menit` : ""}${r.site ? `\nLokasi: ${esc(r.site)} (${r.distance} m)` : ""}`);
    } else {
      const r = await selfCheckOut(actor, pos, "TELEGRAM");
      await clearSession(chatId);
      await restoreKeyboard(chatId, `✅ <b>Absen pulang tercatat</b>\nMasuk ${fmtDateTime(r.checkIn)} · Pulang ${fmtDateTime(r.checkOut)}${r.site ? `\nLokasi: ${esc(r.site)} (${r.distance} m)` : ""}`);
    }
  } catch (e) {
    await sendTelegram(chatId, `❌ ${esc((e as Error).message)}\n\nCoba kirim lokasi lagi, atau tekan Batal.`, { buttons: [cancelRow] });
  }
}

// =====================================================================
// Stok: cek, mutasi, permintaan
// =====================================================================
async function locButtons(itemId: string | null, onlyWithStock: boolean) {
  const [locs, bal] = await Promise.all([prisma.location.findMany({ orderBy: { code: "asc" } }), itemId ? stockBalances(prisma, itemId) : Promise.resolve([])]);
  const qty = (id: string) => bal.find((b) => b.locationId === id)?.qty ?? 0;
  return chunk(
    locs.filter((l) => !onlyWithStock || qty(l.id) > 0).map((l) => ({ text: `${l.name}${itemId ? ` · ${fmtQty(qty(l.id))}` : ""}`.slice(0, 40), callback_data: `f:${l.id}` })),
    2,
  );
}

async function stockSummary(itemId: string) {
  const [item, bal, locs] = await Promise.all([prisma.item.findUniqueOrThrow({ where: { id: itemId } }), stockBalances(prisma, itemId), prisma.location.findMany()]);
  const rows = bal.filter((b) => Math.abs(b.qty) > 1e-9).map((b) => `• ${esc(locs.find((l) => l.id === b.locationId)?.name ?? "?")}: ${fmtQty(b.qty)} ${esc(item.unit)}`);
  const total = bal.reduce((t, b) => t + b.qty, 0);
  const min = Number(item.minStock);
  return [`<b>${esc(item.name)}</b> (${esc(item.sku)})`, ...(rows.length ? rows : ["Belum ada stok."]), `Total: <b>${fmtQty(total)} ${esc(item.unit)}</b>${min > 0 ? ` · limit ${fmtQty(min)}${total <= min ? " ⚠️ perlu order" : ""}` : ""}`].join("\n");
}

const MOVE_TYPES: MovementType[] = ["PENERIMAAN", "PENGELUARAN", "TRANSFER", "PENYESUAIAN"];

async function stokPrompt(s: Session): Promise<Prompt> {
  const d = s.data;
  const title = s.flow === "cek" ? "🔎 Cek stok" : s.flow === "req" ? "📝 Permintaan stok" : "🔁 Mutasi stok";
  const locName = async (id: unknown) => (id ? (await prisma.location.findUnique({ where: { id: String(id) } }))?.name ?? "" : "");
  const lines = [
    `<b>${title}</b>`,
    d.type ? `Jenis: ${MOVEMENT_LABEL[d.type as MovementType]}` : "",
    d.itemName ? `Barang: ${esc(String(d.itemName))}` : "",
    d.fromId ? `Dari: ${esc(await locName(d.fromId))}` : "",
    d.toId ? `Ke: ${esc(await locName(d.toId))}` : "",
    d.locId ? `Lokasi: ${esc(await locName(d.locId))}` : "",
    d.dir ? `Arah: ${d.dir === "plus" ? "tambah (+)" : "kurang (−)"}` : "",
    d.qty != null ? `Jumlah: ${fmtQty(Number(d.qty))} ${esc(String(d.unit ?? ""))}` : "",
    d.unitCost != null ? `Harga/unit: ${idr(Number(d.unitCost))}` : "",
    d.divisionName ? `Divisi: ${esc(String(d.divisionName))}` : "",
    d.note ? `Catatan: ${esc(String(d.note))}` : "",
  ].filter(Boolean);
  const head = lines.join("\n");
  switch (s.step) {
    case "type":
      return { text: `${head}\nPilih jenis mutasi:`, buttons: [...chunk(MOVE_TYPES.filter((t) => t !== "PENYESUAIAN" || d.canAdjust).map((t) => ({ text: MOVEMENT_LABEL[t], callback_data: `f:${t}` })), 2), cancelRow] };
    case "item":
      return itemPrompt(head);
    case "from":
      return { text: `${head}\nAmbil dari lokasi mana? (angka = stok di lokasi)`, buttons: [...(await locButtons(String(d.itemId), true)), cancelRow] };
    case "to":
      return { text: `${head}\nMasuk ke lokasi mana?`, buttons: [...(await locButtons(String(d.itemId), false)).map((r) => r.filter((b) => b.callback_data !== `f:${d.fromId}`)), cancelRow] };
    case "loc":
      return { text: `${head}\nLokasi yang disesuaikan:`, buttons: [...(await locButtons(String(d.itemId), false)), cancelRow] };
    case "dir":
      return { text: `${head}\nStok ditambah atau dikurangi?`, buttons: [[{ text: "➕ Tambah", callback_data: "f:plus" }, { text: "➖ Kurangi", callback_data: "f:minus" }], cancelRow] };
    case "qty":
      return { text: `${head}\n\n✍️ Ketik jumlah dalam <b>${esc(String(d.unit ?? ""))}</b>, contoh: <code>5</code> atau <code>2,5</code>`, buttons: [cancelRow] };
    case "cost":
      return { text: `${head}\n\n✍️ Ketik harga beli per ${esc(String(d.unit ?? "unit"))} (Rp), contoh <code>85000</code>, atau pakai harga rata-rata.`, buttons: [[{ text: `Pakai rata-rata (${idr(Number(d.avgCost ?? 0))})`, callback_data: "f:avg" }], cancelRow] };
    case "div": {
      const divs = await prisma.division.findMany({ where: { active: true }, orderBy: { code: "asc" } });
      return { text: `${head}\nUntuk divisi:`, buttons: [...chunk(divs.map((x) => ({ text: x.name, callback_data: `f:${x.id}` })), 2), cancelRow] };
    }
    case "note":
      return { text: `${head}\n\n✍️ Ketik catatan/referensi (mis. no. nota), atau lewati.`, buttons: [[{ text: "Lewati", callback_data: "f:skip" }], cancelRow] };
    case "confirm":
      return { text: `${head}\n\n${s.flow === "req" ? "Ajukan permintaan ini?" : "Simpan mutasi ini?"}`, buttons: [[{ text: "✅ Simpan", callback_data: "f:ok" }, { text: "❌ Batal", callback_data: "f:x" }]] };
  }
  return { text: head };
}

/** Langkah berikutnya setelah barang & lokasi dipilih */
function afterLocations(s: Session) {
  s.step = "qty";
}

async function stokAnswer(ctx: Ctx, s: Session, v: string, fromText: boolean): Promise<string | null | "done" | Prompt> {
  const d = s.data;
  switch (s.step) {
    case "type":
      if (fromText || !MOVE_TYPES.includes(v as MovementType) || (v === "PENYESUAIAN" && !d.canAdjust)) return "Pilih jenis dengan tombol";
      d.type = v;
      s.step = "item";
      return null;
    case "item": {
      if (!fromText) {
        if (v === "again") return null;
        const it = await prisma.item.findUnique({ where: { id: v } });
        if (!it) return "Barang tidak ditemukan";
        d.itemId = it.id;
        d.itemName = it.name;
        d.unit = it.unit;
        d.avgCost = Number(it.avgCost);
        if (s.flow === "cek") return "done";
        if (s.flow === "req") s.step = "qty";
        else s.step = d.type === "PENERIMAAN" ? "to" : d.type === "PENYESUAIAN" ? "loc" : "from";
        return null;
      }
      return itemChoices(`<b>${s.flow === "cek" ? "🔎 Cek stok" : s.flow === "req" ? "📝 Permintaan stok" : "🔁 Mutasi stok"}</b>`, v);
    }
    case "from":
      if (fromText || !(await prisma.location.findUnique({ where: { id: v } }))) return "Pilih lokasi dengan tombol";
      d.fromId = v;
      if (d.type === "TRANSFER") s.step = "to";
      else afterLocations(s);
      return null;
    case "to":
      if (fromText || !(await prisma.location.findUnique({ where: { id: v } }))) return "Pilih lokasi dengan tombol";
      if (v === d.fromId) return "Lokasi tujuan harus berbeda";
      d.toId = v;
      afterLocations(s);
      return null;
    case "loc":
      if (fromText || !(await prisma.location.findUnique({ where: { id: v } }))) return "Pilih lokasi dengan tombol";
      d.locId = v;
      s.step = "dir";
      return null;
    case "dir":
      if (fromText || (v !== "plus" && v !== "minus")) return "Pilih dengan tombol";
      d.dir = v;
      afterLocations(s);
      return null;
    case "qty": {
      const n = parseQty(v);
      if (n == null || !(n > 0) || n > 1e7) return "Ketik jumlah lebih dari 0, contoh 5 atau 2,5";
      d.qty = n;
      if (s.flow === "req") {
        const div = await userDivision(ctx.i);
        if (div) {
          d.divisionId = div;
          d.divisionName = (await prisma.division.findUnique({ where: { id: div } }))?.name ?? "";
          s.step = "note";
        } else s.step = "div";
      } else s.step = d.type === "PENERIMAAN" ? "cost" : "note";
      return null;
    }
    case "cost": {
      const n = !fromText && v === "avg" ? Number(d.avgCost ?? 0) : parseCount(v.replace(/^rp\.?\s*/i, ""));
      if (n == null || n < 0) return "Ketik harga angka saja, contoh 85000";
      d.unitCost = n;
      s.step = "note";
      return null;
    }
    case "div": {
      const div = fromText ? null : await prisma.division.findUnique({ where: { id: v } });
      if (!div) return "Pilih divisi dengan tombol";
      d.divisionId = div.id;
      d.divisionName = div.name;
      s.step = "note";
      return null;
    }
    case "note":
      d.note = fromText ? v.slice(0, 200) : null;
      s.step = "confirm";
      return null;
    case "confirm": {
      if (v !== "ok") return "Tekan Simpan atau Batal";
      const actor = { id: ctx.i.userId, name: ctx.i.user.name };
      try {
        if (s.flow === "req") {
          if (!can(ctx.i, "stock.request")) return "Anda tidak berwenang";
          const r = await prisma.stockRequest.create({ data: { itemId: String(d.itemId), divisionId: String(d.divisionId), qty: Number(d.qty), note: d.note ? String(d.note) : null, requestedBy: ctx.i.user.name } });
          await audit(actor, "PERMINTAAN_STOK", "StockRequest", r.id, { via: "TELEGRAM" });
        } else {
          if (!can(ctx.i, "stock.move")) return "Anda tidak berwenang";
          const type = d.type as MovementType;
          if (type === "PENYESUAIAN" && !can(ctx.i, "stock.approve")) return "Penyesuaian stok hanya untuk penyetuju stok";
          await prisma.$transaction((tx) =>
            recordMovement(
              tx,
              {
                type,
                itemId: String(d.itemId),
                qty: Number(d.qty),
                fromLocationId: type === "PENYESUAIAN" ? String(d.locId) : d.fromId ? String(d.fromId) : null,
                toLocationId: d.toId ? String(d.toId) : null,
                unitCost: type === "PENERIMAAN" ? Number(d.unitCost) : undefined,
                increase: d.dir === "plus",
                ref: "Telegram",
                note: d.note ? String(d.note) : null,
                date: jakartaDateTime(todayStr(), "12:00"),
              },
              actor,
            ),
          );
        }
      } catch (e) {
        return e instanceof StockError ? e.message : (e as Error).message.slice(0, 200);
      }
      return "done";
    }
  }
  return null;
}

// =====================================================================
// Router
// =====================================================================
async function promptFor(s: Session, i: BotIdent): Promise<Prompt> {
  if (T3_FLOWS[s.flow]) return T3_FLOWS[s.flow].prompt(s, i);
  if (s.flow === "prod") return prodPrompt(s);
  if (s.flow === "absen") return absenPrompt(s);
  return stokPrompt(s);
}

async function finish(ctx: Ctx, s: Session) {
  await clearSession(ctx.chatId);
  if (T3_FLOWS[s.flow]) return present(ctx, await T3_FLOWS[s.flow].finish(ctx, s));
  const d = s.data;
  const again = (flow: string, label: string): InlineButton[][] => [[{ text: label, callback_data: `f:start:${flow}` }, { text: MENU_TEXT, callback_data: "m:home" }]];
  if (s.flow === "prod") return present(ctx, { text: `✅ <b>Hasil produksi tersimpan</b>\n${esc(String(d.employeeName ?? ""))} · ${STAGE_LABEL[d.stage as ProductionStage]} · ${esc(String(d.productName))}\nHasil baik ${d.qtyGood} pcs · Reject ${d.qtyReject} pcs`, buttons: again("prod", "🏭 Input lagi") });
  if (s.flow === "cek") return present(ctx, { text: await stockSummary(String(d.itemId)), buttons: again("cek", "🔎 Cek barang lain") });
  if (s.flow === "req") return present(ctx, { text: `✅ <b>Permintaan stok diajukan</b>\n${esc(String(d.itemName))}: ${fmtQty(Number(d.qty))} ${esc(String(d.unit))} untuk ${esc(String(d.divisionName))}\nMenunggu persetujuan.`, buttons: again("req", "📝 Ajukan lagi") });
  return present(ctx, { text: `✅ <b>Mutasi stok tercatat</b>\n${MOVEMENT_LABEL[d.type as MovementType]} · ${esc(String(d.itemName))} ${fmtQty(Number(d.qty))} ${esc(String(d.unit))}\n\n${await stockSummary(String(d.itemId))}`, buttons: again("mut", "🔁 Mutasi lagi") });
}

async function start(ctx: Ctx, flow: string) {
  const { i, chatId } = ctx;
  let r: Session | string | Prompt;
  if (flow === "stok") return present(ctx, stockMenu(i));
  if (T3_FLOWS[flow]) r = await T3_FLOWS[flow].start(ctx);
  else if (flow === "prod") r = await prodStart(ctx);
  else if (flow === "absen") r = await absenStart(ctx);
  else if (flow === "cek") r = can(i, "stock.view") ? { chatId, userId: i.userId, flow: "cek", step: "item", data: {} } : "Anda tidak berwenang melihat stok";
  else if (flow === "mut") r = can(i, "stock.move") ? { chatId, userId: i.userId, flow: "mut", step: "type", data: { canAdjust: can(i, "stock.approve") ? 1 : 0 } } : "Anda tidak berwenang mencatat mutasi stok";
  else if (flow === "req") r = can(i, "stock.request") ? { chatId, userId: i.userId, flow: "req", step: "item", data: {} } : "Anda tidak berwenang mengajukan permintaan stok";
  else r = "Menu tidak dikenal";
  if (typeof r === "string") return sendTelegram(chatId, `❌ ${esc(r)}`);
  if (!("flow" in r)) return present(ctx, r);
  await save(r);
  return present(ctx, await promptFor(r, i));
}

async function answer(ctx: Ctx, s: Session, v: string, fromText: boolean) {
  const step0 = s.step;
  const res = T3_FLOWS[s.flow] ? await T3_FLOWS[s.flow].answer(ctx, s, v, fromText) : s.flow === "prod" ? await prodAnswer(ctx, s, v, fromText) : s.flow === "absen" ? (fromText ? "Kirim lokasi dengan tombol 📍 di bawah kolom chat" : null) : await stokAnswer(ctx, s, v, fromText);
  if (res === "done") return finish(ctx, s);
  if (typeof res === "string") {
    await sendTelegram(ctx.chatId, `⚠️ ${esc(res)}\n<i>Ketik /batal untuk membatalkan isian.</i>`);
    // Gagal saat menyimpan (mis. stok asal tidak cukup): kembali ke isian jumlah agar bisa diperbaiki
    if (s.step !== step0) {
      // Isian dikembalikan ke langkah sebelumnya oleh alur (mis. stok kurang)
      await save(s);
      return present({ ...ctx, messageId: undefined }, await promptFor(s, ctx.i));
    }
    if (step0 === "confirm" && (s.flow === "mut" || s.flow === "req")) {
      s.step = "qty";
      await save(s);
      return present({ ...ctx, messageId: undefined }, await promptFor(s, ctx.i));
    }
    return;
  }
  await save(s);
  // Hasil pencarian barang: tampilkan pilihan tanpa pindah langkah
  if (res && typeof res === "object") return present({ ...ctx, messageId: undefined }, res);
  return present(ctx, await promptFor(s, ctx.i));
}

/** Tombol isian (callback_data diawali "f:") */
export async function handleFlowCallback(i: BotIdent, cbId: string, chatId: string, messageId: number, data: string) {
  const [, a, b] = data.split(":");
  const ctx: Ctx = { i, chatId, messageId };
  if (a === "start") {
    await answerCallback(cbId, "");
    await clearSession(chatId);
    return start(ctx, b);
  }
  if (a === "x") {
    const s = await getSession(chatId);
    await clearSession(chatId);
    await answerCallback(cbId, "Dibatalkan");
    if (s?.flow === "absen") return restoreKeyboard(chatId, "Absen dibatalkan.");
    return present(ctx, { text: "Isian dibatalkan.", buttons: [[{ text: MENU_TEXT, callback_data: "m:home" }]] });
  }
  const s = await getSession(chatId);
  if (!s || s.userId !== i.userId) return answerCallback(cbId, "Isian sudah kedaluwarsa, mulai lagi dari 📋 Menu");
  await answerCallback(cbId, "");
  if (a === "pg") {
    s.data.page = Math.max(0, Number(b) || 0);
    await save(s);
    return present(ctx, await promptFor(s, ctx.i));
  }
  return answer(ctx, s, data.slice(2), false);
}

/** Pesan teks saat isian aktif. Mengembalikan true bila teks dipakai oleh isian. */
export async function handleFlowText(i: BotIdent, chatId: string, text: string): Promise<boolean> {
  const s = await getSession(chatId);
  if (!s) return false;
  if (s.userId !== i.userId) {
    await clearSession(chatId);
    return false;
  }
  if (text === "/batal") {
    await clearSession(chatId);
    if (s.flow === "absen") await restoreKeyboard(chatId, "Isian dibatalkan.");
    else await sendTelegram(chatId, "Isian dibatalkan.", { buttons: [[{ text: MENU_TEXT, callback_data: "m:home" }]] });
    return true;
  }
  await answer({ i, chatId }, s, text, true);
  return true;
}
