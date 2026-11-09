import type { Role } from "@prisma/client";
import { prisma } from "./db";
import type { Permission } from "./rbac";
import { alertsFor } from "./alerts";
import { bankBalances } from "./finance";
import { productionSummary } from "./dashboard";
import { lowStockItems } from "./stock";
import { dailyRecapText } from "./jobs";
import { idr } from "./money";
import { addDays, dateStr, fmtDate, jakartaDateTime, jakartaParts, MONTHS, todayStr } from "./time";
import { answerCallback, chatAction, editTelegram, esc, sendTelegram, sendTelegramDocument, type InlineButton } from "./telegram";
import { renderDocJpg, RenderError } from "./render";
import { inputMenuRows } from "./botFlow";
import { sendSaleNota } from "./botSales";

/** Teks tombol menu tetap di bawah kolom chat */
export const MENU_TEXT = "📋 Menu";

export type BotIdent = {
  userId: string;
  canSubmit: boolean;
  perms: Set<Permission>;
  user: { name: string; role: Role; divisionId: string | null; employeeId: string | null };
};

const can = (i: BotIdent, ...p: Permission[]) => p.some((x) => i.perms.has(x));
const back = (data = "m:home", text = "⬅ Kembali"): InlineButton[] => [{ text, callback_data: data }];
const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** Divisi pengguna (Kapten/Operator hanya melihat divisinya sendiri, sama seperti di web) */
async function ownDivision(i: BotIdent): Promise<string | null> {
  if (i.user.role !== "KAPTEN_DIVISI" && i.user.role !== "OPERATOR") return null;
  if (i.user.divisionId) return i.user.divisionId;
  if (!i.user.employeeId) return null;
  return (await prisma.employee.findUnique({ where: { id: i.user.employeeId }, select: { divisionId: true } }))?.divisionId ?? null;
}

function hasReports(i: BotIdent) {
  return can(i, "accounting.view", "report.view", "payroll.view") || (can(i, "payroll.self") && !!i.user.employeeId);
}

// ---------- Menu ----------
export function mainMenu(i: BotIdent): { text: string; buttons: InlineButton[][] } {
  const rows: InlineButton[][] = [];
  rows.push([{ text: "📊 Ringkasan hari ini", callback_data: "m:sum" }]);
  rows.push(...inputMenuRows(i));
  if (hasReports(i)) rows.push([{ text: "📄 Unduh laporan (JPG)", callback_data: "m:rpt" }]);
  if (i.canSubmit && can(i, "finance.create")) rows.push([{ text: "💸 Catat transaksi", callback_data: "m:tx" }]);
  if (can(i, "dashboard.finance")) rows.push([{ text: "🗓 Rekap kemarin", callback_data: "m:rkp" }]);
  return { text: `<b>Menu ERP Main Gypsum</b>\nHalo, ${esc(i.user.name)}. Pilih menu:`, buttons: rows };
}

function reportMenu(i: BotIdent): { text: string; buttons: InlineButton[][] } {
  const rows: InlineButton[][] = [];
  if (can(i, "accounting.view")) {
    rows.push([{ text: "Arus kas", callback_data: "m:p:ak" }, { text: "Laba rugi", callback_data: "m:p:lr" }]);
    rows.push([{ text: "Neraca", callback_data: "m:p:nr" }]);
  }
  if (can(i, "report.view")) rows.push([{ text: "Laporan shift", callback_data: "m:ls:0" }, { text: "Rekap produksi", callback_data: "m:p:rk" }]);
  if (can(i, "payroll.view")) rows.push([{ text: "Slip gaji karyawan", callback_data: "m:sp:0" }]);
  if (can(i, "payroll.self") && i.user.employeeId) rows.push([{ text: "Slip gaji saya", callback_data: "m:sl" }]);
  rows.push(back());
  return { text: "<b>Unduh laporan (JPG)</b>\nPilih laporan. JPG dikirim dengan kop surat yang sama seperti di website.", buttons: rows };
}

// ---------- Periode & dokumen JPG ----------
function monthBounds(offset: 0 | -1) {
  const p = jakartaParts();
  const first = `${p.year}-${String(p.month).padStart(2, "0")}-01`;
  if (offset === 0) return { from: first, to: todayStr(), label: `${MONTHS[p.month - 1]} ${p.year} (s/d hari ini)` };
  const to = addDays(first, -1);
  const m = Number(to.slice(5, 7));
  return { from: `${to.slice(0, 8)}01`, to, label: `${MONTHS[m - 1]} ${to.slice(0, 4)}` };
}

const DOC_TITLE: Record<string, string> = { ak: "Arus kas", lr: "Laba rugi", nr: "Neraca", rk: "Rekap produksi" };

function periodMenu(kind: string): { text: string; buttons: InlineButton[][] } {
  const opts: [string, string][] =
    kind === "nr"
      ? [["Per hari ini", "now"], ["Per akhir bulan lalu", "prev"]]
      : kind === "rk"
        ? [["Hari ini", "h"], ["Kemarin", "k"], ["Minggu ini", "m"], ["Bulan ini", "b"]]
        : [["Bulan ini", "cur"], ["Bulan lalu", "prev"]];
  return { text: `<b>${DOC_TITLE[kind]}</b>\nPilih periode:`, buttons: [...chunk(opts.map(([t, v]) => ({ text: t, callback_data: `m:j:${kind}:${v}` })), 2), back("m:rpt")] };
}

type Doc = { path: string; target: string; filename: string; caption: string };

/** Peta tombol → halaman ERP + id DocSheet. Hak akses dicek lagi oleh halaman itu sendiri saat dirender. */
async function docFor(i: BotIdent, kind: string, arg: string): Promise<Doc | string> {
  if (kind === "ak" || kind === "lr") {
    if (!can(i, "accounting.view")) return "Anda tidak berwenang melihat laporan keuangan";
    const r = monthBounds(arg === "prev" ? -1 : 0);
    const q = `from=${r.from}&to=${r.to}`;
    return kind === "ak"
      ? { path: `/akuntansi/arus-kas?${q}`, target: "ak", filename: `arus-kas-${r.from}-${r.to}`, caption: `Laporan arus kas · ${r.label}` }
      : { path: `/akuntansi/laba-rugi?${q}`, target: "lr", filename: `laba-rugi-${r.from}-${r.to}`, caption: `Laporan laba rugi · ${r.label}` };
  }
  if (kind === "nr") {
    if (!can(i, "accounting.view")) return "Anda tidak berwenang melihat laporan keuangan";
    const to = arg === "prev" ? monthBounds(-1).to : todayStr();
    return { path: `/akuntansi/neraca?to=${to}`, target: "nr", filename: `neraca-${to}`, caption: `Neraca per ${fmtDate(jakartaDateTime(to, "12:00"))}` };
  }
  if (kind === "rk") {
    if (!can(i, "report.view")) return "Anda tidak berwenang melihat laporan produksi";
    const today = todayStr();
    const [period, date, label] = arg === "k" ? ["harian", addDays(today, -1), "kemarin"] : arg === "m" ? ["mingguan", today, "minggu ini"] : arg === "b" ? ["bulanan", today, "bulan ini"] : ["harian", today, "hari ini"];
    return { path: `/laporan/rekap?period=${period}&date=${date}`, target: "rekap", filename: `rekap-produksi-${period}-${date}`, caption: `Rekap produksi ${label}` };
  }
  if (kind === "ls") {
    if (!can(i, "report.view")) return "Anda tidak berwenang melihat laporan shift";
    const r = await prisma.shiftReport.findUnique({ where: { id: arg }, include: { division: true, shift: true } });
    if (!r) return "Laporan tidak ditemukan";
    const day = dateStr(r.date);
    return { path: `/laporan/${r.id}`, target: "report-preview", filename: `laporan-${r.division.code}-${r.shift.code}-${day}`, caption: `Laporan shift ${esc(r.division.name)} · ${esc(r.shift.name)} · ${fmtDate(r.date)}` };
  }
  if (kind === "sl") {
    const s = await prisma.payslip.findUnique({ where: { id: arg }, include: { employee: true, period: true } });
    if (!s) return "Slip tidak ditemukan";
    const own = can(i, "payroll.self") && s.employeeId === i.user.employeeId;
    if (!own && !can(i, "payroll.view")) return "Anda hanya dapat mengunduh slip gaji sendiri";
    return { path: `/gaji/slip/${s.id}`, target: "slip", filename: `slip-${s.employee.code}-${s.period.code}`, caption: `Slip ${s.period.kind === "TUNJANGAN" ? "tunjangan" : "gaji"} ${esc(s.employee.name)} · ${esc(s.period.code)}` };
  }
  return "Dokumen tidak dikenal";
}

const busy = new Set<string>();

async function sendDoc(i: BotIdent, chatId: string, doc: Doc) {
  if (busy.has(i.userId)) return sendTelegram(chatId, "⏳ JPG sebelumnya masih dibuat, tunggu sebentar.");
  busy.add(i.userId);
  try {
    await chatAction(chatId, "upload_document");
    const jpg = await renderDocJpg(i.userId, doc.path, doc.target);
    const r = await sendTelegramDocument(chatId, jpg, `${doc.filename}.jpg`, doc.caption, { buttons: [[{ text: "📄 Laporan lain", callback_data: "m:rpt" }, { text: MENU_TEXT, callback_data: "m:home" }]], type: "LAPORAN_JPG" });
    if (!r.ok) await sendTelegram(chatId, `Gagal mengirim JPG: ${esc(r.error ?? "")}`);
  } catch (e) {
    const msg = e instanceof RenderError ? e.message : "terjadi kesalahan saat membuat JPG";
    await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "LAPORAN_JPG", target: chatId, status: "GAGAL", payload: doc.path, error: (e as Error).message.slice(0, 500) } });
    await sendTelegram(chatId, `❌ JPG belum bisa dibuat: ${esc(msg)}. Coba lagi nanti atau unduh dari website.`);
  } finally {
    busy.delete(i.userId);
  }
}

// ---------- Daftar pilihan ----------
const PAGE = 8;

async function shiftReportList(i: BotIdent, page: number) {
  const div = await ownDivision(i);
  const rows = await prisma.shiftReport.findMany({
    where: div ? { divisionId: div } : {},
    include: { division: true, shift: true },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    skip: page * PAGE,
    take: PAGE + 1,
  });
  const btns = rows.slice(0, PAGE).map((r) => [{ text: `${dateStr(r.date).slice(8, 10)}/${dateStr(r.date).slice(5, 7)} · ${r.division.name} · ${r.shift.name}${r.status === "DRAFT" ? " (draft)" : ""}`.slice(0, 60), callback_data: `m:j:ls:${r.id}` }]);
  const nav: InlineButton[] = [];
  if (page > 0) nav.push({ text: "◀ Lebih baru", callback_data: `m:ls:${page - 1}` });
  if (rows.length > PAGE) nav.push({ text: "Lebih lama ▶", callback_data: `m:ls:${page + 1}` });
  return { text: rows.length ? "<b>Laporan shift</b>\nPilih laporan yang mau diunduh:" : "Belum ada laporan shift.", buttons: [...btns, ...(nav.length ? [nav] : []), back("m:rpt")] };
}

async function ownSlips(i: BotIdent) {
  const rows = i.user.employeeId ? await prisma.payslip.findMany({ where: { employeeId: i.user.employeeId }, include: { period: true }, orderBy: { period: { startDate: "desc" } }, take: PAGE }) : [];
  return {
    text: rows.length ? "<b>Slip gaji saya</b>\nPilih periode:" : "Belum ada slip gaji untuk Anda.",
    buttons: [...rows.map((s) => [{ text: `${s.period.code}${s.period.kind === "TUNJANGAN" ? " (tunjangan)" : ""} · ${idr(s.total)}`.slice(0, 60), callback_data: `m:j:sl:${s.id}` }]), back("m:rpt")],
  };
}

async function periodList(page: number) {
  const rows = await prisma.payrollPeriod.findMany({ where: { payslips: { some: {} } }, orderBy: [{ startDate: "desc" }, { code: "desc" }], skip: page * PAGE, take: PAGE + 1 });
  const nav: InlineButton[] = [];
  if (page > 0) nav.push({ text: "◀ Lebih baru", callback_data: `m:sp:${page - 1}` });
  if (rows.length > PAGE) nav.push({ text: "Lebih lama ▶", callback_data: `m:sp:${page + 1}` });
  return {
    text: rows.length ? "<b>Slip gaji karyawan</b>\nPilih periode penggajian:" : "Belum ada periode penggajian.",
    buttons: [...rows.slice(0, PAGE).map((p) => [{ text: `${p.code} · ${fmtDate(p.startDate)}–${fmtDate(p.endDate)}`.slice(0, 60), callback_data: `m:spp:${p.id}:0` }]), ...(nav.length ? [nav] : []), back("m:rpt")],
  };
}

async function slipsOfPeriod(periodId: string, page: number) {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) return { text: "Periode tidak ditemukan.", buttons: [back("m:sp:0")] };
  const rows = await prisma.payslip.findMany({ where: { periodId }, include: { employee: true }, orderBy: { employee: { name: "asc" } }, skip: page * 10, take: 11 });
  const nav: InlineButton[] = [];
  if (page > 0) nav.push({ text: "◀ Sebelumnya", callback_data: `m:spp:${periodId}:${page - 1}` });
  if (rows.length > 10) nav.push({ text: "Berikutnya ▶", callback_data: `m:spp:${periodId}:${page + 1}` });
  return {
    text: `<b>Slip gaji ${esc(period.code)}</b>\nPilih karyawan:`,
    buttons: [...chunk(rows.slice(0, 10).map((s) => ({ text: s.employee.name.slice(0, 30), callback_data: `m:j:sl:${s.id}` })), 2), ...(nav.length ? [nav] : []), back("m:sp:0")],
  };
}

// ---------- Ringkasan ----------
export async function summaryText(i: BotIdent) {
  const today = todayStr();
  const div = await ownDivision(i);
  const out: string[] = [`<b>📊 Ringkasan ${fmtDate(jakartaDateTime(today, "12:00"))}</b>`];
  const tasks: Promise<void>[] = [];
  const parts: Record<string, string[]> = {};
  if (can(i, "production.view", "dashboard.view")) {
    tasks.push(
      productionSummary(today, { divisionId: div }).then((p) => {
        parts.prod = [`<b>Produksi hari ini${div ? " (divisi Anda)" : ""}</b>`, `Hasil: ${p.good} pcs · Reject: ${p.reject} pcs (${p.rejectRate}%)`, `Barang jadi: ${p.finished} pcs${p.target ? ` · Target: ${p.achieved}/${p.target}` : ""}`];
      }),
    );
  }
  if (can(i, "dashboard.finance")) {
    tasks.push(
      bankBalances().then((banks) => {
        const total = banks.reduce((t, b) => t + b.balance, 0);
        parts.bank = [`<b>Saldo rekening</b>`, ...banks.map((b) => `• ${esc(b.name)}: ${idr(b.balance)}`), `Total: <b>${idr(total)}</b>`];
      }),
    );
  }
  if (can(i, "stock.view")) {
    tasks.push(
      lowStockItems().then((low) => {
        if (low.length) parts.stock = [`<b>⚠️ Stok menipis (${low.length})</b>`, ...low.slice(0, 10).map((x) => `• ${esc(x.name)}: ${Math.round(x.qty * 100) / 100} ${esc(x.unit)} (min ${x.min})`), ...(low.length > 10 ? [`…dan ${low.length - 10} lainnya`] : [])];
      }),
    );
  }
  tasks.push(
    alertsFor((p) => i.perms.has(p), div).then((alerts) => {
      const list = alerts.filter((a) => a.key !== "lowstock");
      if (list.length) parts.alerts = [`<b>Perlu tindakan</b>`, ...list.map((a) => `${a.tone === "red" ? "🔴" : a.tone === "amber" ? "🟠" : "🔵"} ${esc(a.label)}: ${a.count}`)];
    }),
  );
  await Promise.all(tasks);
  for (const k of ["prod", "bank", "alerts", "stock"]) if (parts[k]) out.push("", ...parts[k]);
  if (out.length === 1) out.push("", "Tidak ada data yang bisa ditampilkan untuk akun Anda.");
  if (!parts.alerts) out.push("", "✅ Tidak ada pekerjaan tertunda.");
  return out.join("\n");
}

const TX_HELP =
  "<b>💸 Catat transaksi</b>\nKirim pesan atau foto bukti transaksi ke chat ini, contoh:\n<i>bayar listrik 350rb dari seabank hari ini</i>\n<i>terima pencairan shopee 1,2jt ke saldo penjual</i>\n<i>transfer internal dari saldo penjual ke seabank 500rb</i>\n\nAtau kirim <b>foto bukti transfer/nota</b> dengan caption keterangan, misal <i>beli cat supplier A</i>. Saya buatkan DRAFT lalu minta konfirmasi.";

// ---------- Penanganan ----------
/** Perintah teks yang membuka menu. Mengembalikan true bila sudah ditangani. */
export async function handleMenuCommand(i: BotIdent, chatId: string, text: string): Promise<boolean> {
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  if (text === MENU_TEXT || cmd === "/menu" || cmd === "/start") {
    const m = mainMenu(i);
    await sendTelegram(chatId, "Gunakan tombol <b>📋 Menu</b> di bawah kapan saja.", { keyboard: [[MENU_TEXT]], type: "MENU" });
    await sendTelegram(chatId, m.text, { buttons: m.buttons, type: "MENU" });
    return true;
  }
  if (cmd === "/ringkasan") {
    await sendTelegram(chatId, await summaryText(i), { buttons: [back("m:home", MENU_TEXT)], type: "RINGKASAN" });
    return true;
  }
  if (cmd === "/laporan") {
    const m = hasReports(i) ? reportMenu(i) : { text: "Tidak ada laporan yang bisa Anda unduh.", buttons: [back()] };
    await sendTelegram(chatId, m.text, { buttons: m.buttons, type: "MENU" });
    return true;
  }
  return false;
}

/** Tombol menu (callback_data diawali "m:") */
export async function handleMenuCallback(i: BotIdent, cbId: string, chatId: string, messageId: number, data: string) {
  const [, action, a1, a2] = data.split(":");
  const show = async (m: { text: string; buttons: InlineButton[][] }) => {
    await answerCallback(cbId, "");
    await editTelegram(chatId, messageId, m.text, m.buttons);
  };
  switch (action) {
    case "home":
      return show(mainMenu(i));
    case "sum":
      await answerCallback(cbId, "Memuat ringkasan…");
      return sendTelegram(chatId, await summaryText(i), { buttons: [back("m:home", MENU_TEXT)], type: "RINGKASAN" });
    case "rkp":
      if (!can(i, "dashboard.finance")) return answerCallback(cbId, "Anda tidak berwenang");
      await answerCallback(cbId, "");
      return sendTelegram(chatId, await dailyRecapText(new Date()), { buttons: [back("m:home", MENU_TEXT)], type: "REKAP_MANUAL" });
    case "tx":
      return show({ text: TX_HELP, buttons: [back()] });
    case "rpt":
      return show(hasReports(i) ? reportMenu(i) : { text: "Tidak ada laporan yang bisa Anda unduh.", buttons: [back()] });
    case "p":
      if (!DOC_TITLE[a1]) return answerCallback(cbId, "Pilihan tidak dikenal");
      return show(periodMenu(a1));
    case "ls":
      if (!can(i, "report.view")) return answerCallback(cbId, "Anda tidak berwenang");
      return show(await shiftReportList(i, Math.max(0, Number(a1) || 0)));
    case "sl":
      return show(await ownSlips(i));
    case "sp":
      if (!can(i, "payroll.view")) return answerCallback(cbId, "Anda tidak berwenang");
      return show(await periodList(Math.max(0, Number(a1) || 0)));
    case "spp":
      if (!can(i, "payroll.view")) return answerCallback(cbId, "Anda tidak berwenang");
      return show(await slipsOfPeriod(a1, Math.max(0, Number(a2) || 0)));
    case "nota":
      // Nota penjualan JPG (dari tombol setelah cicilan / pengingat piutang)
      if (!can(i, "sales.view", "sales.manage")) return answerCallback(cbId, "Anda tidak berwenang");
      await answerCallback(cbId, "Membuat nota JPG, tunggu sebentar…");
      return sendSaleNota(i, chatId, a1);
    case "j": {
      const doc = await docFor(i, a1, a2 ?? "");
      if (typeof doc === "string") return answerCallback(cbId, doc);
      await answerCallback(cbId, "Membuat JPG, tunggu sebentar…");
      return sendDoc(i, chatId, doc);
    }
    default:
      return answerCallback(cbId, "Menu tidak dikenal");
  }
}
