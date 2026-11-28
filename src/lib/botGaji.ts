import { prisma } from "./db";
import { paySlip, PayrollError } from "./payroll";
import { matchEmployees } from "./employeeMatch";
import { idr } from "./money";
import { fmtDate, fmtDay, jakartaDateTime, todayStr } from "./time";
import { esc, type InlineButton } from "./telegram";
import { cancelRow, can, chunk, MENU_TEXT, PAGE, pager, type Ctx, type Session } from "./botKit";
import type { FlowDef } from "./botFlow3";

/**
 * Bayar slip gaji langsung dari bot Telegram ("gaji rico okt" + foto bukti transfer).
 * Memakai fungsi pembayaran yang SAMA dengan web Penggajian → Bayar (paySlip → jurnal pelunasan Hutang Gaji),
 * jadi tidak ada beban gaji dobel dan tidak ada draft transaksi untuk pesan yang sama.
 */
export const PAY_WORDS = /\b(gaji|gajian|upah|bayaran|slip)\b/i;
const head = "💰 <b>Bayar gaji karyawan</b>";
const menuBtn: InlineButton[] = [{ text: MENU_TEXT, callback_data: "m:home" }];
const plainRow: InlineButton[] = [{ text: "📝 Bukan gaji slip (catat beban biasa)", callback_data: "f:plain" }, { text: "✏️ Ubah jenis", callback_data: "f:jns" }];

export type GajiPrefill = { text: string; amount: number | null; bankId: string | null; date: string | null; time: string | null; proofPath: string | null; messageId: string; tx: unknown };

const activeEmployees = () =>
  prisma.employee.findMany({ where: { status: { not: "NONAKTIF" } }, select: { id: true, name: true, nickname: true, division: { select: { name: true } } }, orderBy: [{ division: { name: "asc" } }, { name: "asc" }] });

/** Slip disetujui yang belum dibayar milik karyawan (bisa dibayar dari bot) */
export function payableSlips(employeeId: string) {
  return prisma.payslip.findMany({
    where: { employeeId, paidAt: null, total: { gt: 0 }, period: { status: "DISETUJUI" } },
    include: { period: { select: { code: true, startDate: true, endDate: true } } },
    orderBy: { period: { endDate: "asc" } },
  });
}

export const usedGajiText = (s: Session) => `💰 <b>Bayar gaji karyawan</b>\n\n✅ Bukti ini sudah dipakai untuk membayar gaji <b>${esc(String(s.data.used))}</b>. Tidak dicatat lagi.`;

/** Pesan gaji dikenali: mulai isian bayar slip (hanya yang berhak membayar gaji, sama dengan web) */
export async function prefilledGaji(ctx: Ctx, p: GajiPrefill): Promise<Session | null> {
  if (!can(ctx.i, "payroll.approve")) return null;
  // Pesan/bukti yang sama sudah dipakai membayar slip: jangan diproses lagi (juga tidak jadi draft)
  const used = await prisma.payslip.findUnique({ where: { paidMessageId: p.messageId }, include: { employee: { select: { name: true } }, period: { select: { code: true } } } });
  const s: Session = {
    chatId: ctx.chatId,
    userId: ctx.i.userId,
    flow: "gaji",
    step: used ? "used" : "emp",
    data: { page: 0, all: null, empId: null, slipId: null, bankId: p.bankId, read: p.amount, date: p.date ?? todayStr(), time: p.time, proofPath: p.proofPath, msgId: p.messageId, tx: JSON.stringify(p.tx), cands: null, used: used ? `${used.employee.name} ${used.period.code}` : null },
  };
  if (used) return s;
  const m = matchEmployees(p.text, await activeEmployees());
  if (m.sure) {
    s.data.empId = m.sure.id;
    s.step = "slip";
  } else s.data.cands = JSON.stringify(m.similar.map((e) => e.id));
  return s;
}

async function prompt(s: Session) {
  const d = s.data;
  // "Bukan gaji slip": hanya bila pesan bisa dicatat sebagai transaksi biasa (nominal terbaca)
  const plain: InlineButton[][] = d.tx && d.tx !== "null" ? [plainRow] : [];
  if (s.step === "used") return { text: `${head}\n\n✅ Bukti ini sudah dipakai untuk membayar gaji <b>${esc(String(d.used))}</b>. Tidak dicatat lagi.`, buttons: [menuBtn] };
  const emps = await activeEmployees();
  if (s.step === "emp") {
    const cands: string[] = d.cands ? JSON.parse(String(d.cands)) : [];
    if (cands.length && !d.all) {
      const list = cands.map((id) => emps.find((e) => e.id === id)).filter((e): e is (typeof emps)[number] => !!e);
      return {
        text: `${head}\n\nKaryawan mana yang dibayar? Nama di pesan mirip beberapa karyawan:`,
        buttons: [...list.map((e) => [{ text: `${e.name} · ${e.division.name}`.slice(0, 60), callback_data: `f:e:${e.id}` }]), [{ text: "📋 Semua karyawan", callback_data: "f:all" }], ...plain, cancelRow],
      };
    }
    const page = Number(d.page) || 0;
    const shown = emps.slice(page * PAGE, page * PAGE + PAGE);
    return {
      text: `${head}\n\n${cands.length ? "" : "Nama karyawan tidak dikenali dari pesan. "}Pilih karyawan (urut divisi), atau ✍️ ketik namanya:`,
      buttons: [...shown.map((e) => [{ text: `${e.name} · ${e.division.name}`.slice(0, 60), callback_data: `f:e:${e.id}` }]), ...pager(page, emps.length > (page + 1) * PAGE), ...plain, cancelRow],
    };
  }
  const emp = emps.find((e) => e.id === d.empId);
  const who = emp ? `${esc(emp.name)} · ${esc(emp.division.name)}` : "-";
  const changeEmp: InlineButton[] = [{ text: "↩ Ganti karyawan", callback_data: "f:emp" }];
  if (s.step === "slip") {
    const slips = await payableSlips(String(d.empId));
    if (!slips.length)
      return { text: `${head}\nKaryawan: <b>${who}</b>\n\nTidak ada slip gaji <b>disetujui</b> yang belum dibayar untuk karyawan ini. Bila ini memang pengeluaran gaji di luar slip, catat sebagai beban biasa.`, buttons: [...plain, changeEmp, cancelRow] };
    return {
      text: `${head}\nKaryawan: <b>${who}</b>\n\nSlip disetujui yang belum dibayar:\n${slips.map((x) => `• ${esc(x.period.code)} (${fmtDate(x.period.startDate)} – ${fmtDate(x.period.endDate)}): <b>${idr(x.total)}</b>`).join("\n")}`,
      buttons: [...slips.map((x) => [{ text: `Bayar slip ${x.period.code} · ${idr(x.total)}`.slice(0, 60), callback_data: `f:s:${x.id}` }]), ...plain, changeEmp, cancelRow],
    };
  }
  const slip = d.slipId ? await prisma.payslip.findUnique({ where: { id: String(d.slipId) }, include: { period: { select: { code: true } } } }) : null;
  if (s.step === "bank") {
    const banks = await prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } });
    return { text: `${head}\nKaryawan: <b>${who}</b>\nSlip: ${esc(slip?.period.code ?? "-")} · ${idr(slip?.total ?? 0)}\n\nDibayar dari rekening mana?`, buttons: [...chunk(banks.map((b) => ({ text: b.name.slice(0, 30), callback_data: `f:b:${b.id}` })), 2), cancelRow] };
  }
  // Konfirmasi akhir
  const bank = d.bankId ? await prisma.bankAccount.findUnique({ where: { id: String(d.bankId) } }) : null;
  const total = Number(slip?.total ?? 0);
  const check = checkAmount(d.read == null ? null : Number(d.read), total);
  return {
    text: [
      `${head}\n<b>Periksa sebelum dibukukan:</b>`,
      `Karyawan: <b>${who}</b>`,
      `Periode: <b>${esc(slip?.period.code ?? "-")}</b>`,
      `Nominal: <b>${idr(total)}</b> (sisa slip)`,
      `Rekening: <b>${esc(bank?.name ?? "-")}</b>`,
      `Tanggal: <b>${fmtDay(new Date(`${d.date}T12:00:00Z`))}</b>`,
      d.proofPath ? "Bukti transfer: terlampir 📎" : "Bukti transfer: tidak ada",
      "",
      check.text,
      "Dibukukan sebagai pelunasan Hutang Gaji (bukan beban baru).",
    ].join("\n"),
    buttons: [...(check.ok ? [[{ text: "✅ Bayar & bukukan", callback_data: "f:ok" }]] : []), [{ text: "🏦 Ganti rekening", callback_data: "f:bank" }, { text: "↩ Ganti slip", callback_data: "f:slip" }], ...plain, cancelRow],
  };
}

/** Nominal di bukti vs sisa slip. Bayar sebagian belum didukung (web juga membayar penuh); lebih besar ditolak. */
export function checkAmount(read: number | null, total: number): { ok: boolean; text: string } {
  if (total <= 0) return { ok: false, text: "⚠️ Slip ini tidak punya sisa yang perlu dibayar." };
  if (read == null || !Number.isFinite(read) || read <= 0) return { ok: true, text: "ℹ️ Nominal di bukti tidak terbaca; yang dibukukan = sisa slip." };
  if (read === total) return { ok: true, text: `Nominal di bukti cocok: ${idr(read)} ✓` };
  if (read > total) return { ok: false, text: `⛔ Nominal di bukti ${idr(read)} LEBIH BESAR dari sisa slip ${idr(total)}. Tidak bisa dibukukan sebagai bayar slip; catat selisihnya sebagai transaksi terpisah atau periksa ulang.` };
  return { ok: false, text: `⛔ Nominal di bukti ${idr(read)} lebih kecil dari sisa slip ${idr(total)}. Bayar sebagian belum didukung (sama dengan web); transfer penuh lalu kirim buktinya, atau catat sebagai beban biasa.` };
}

export const gajiFlow: FlowDef = {
  async start(ctx) {
    if (!can(ctx.i, "payroll.approve")) return "Anda tidak berwenang membayar gaji";
    return { chatId: ctx.chatId, userId: ctx.i.userId, flow: "gaji", step: "emp", data: { page: 0, all: "1", tx: null, date: todayStr(), read: null, bankId: null } };
  },
  prompt: (s) => prompt(s),
  async answer(ctx, s, v, fromText) {
    const d = s.data;
    if (s.step === "used") return "done";
    if (fromText) {
      if (s.step !== "emp" && s.step !== "slip") return "Pilih dengan tombol di atas";
      const m = matchEmployees(v, await activeEmployees());
      if (m.sure) {
        d.empId = m.sure.id;
        s.step = "slip";
        return null;
      }
      d.cands = JSON.stringify(m.similar.map((e) => e.id));
      d.all = m.similar.length ? null : "1";
      d.page = 0;
      s.step = "emp";
      return m.similar.length ? null : "Nama tidak ditemukan; pilih dari daftar karyawan";
    }
    if (v === "all") {
      d.all = "1";
      d.page = 0;
      return null;
    }
    if (v === "emp") {
      s.step = "emp";
      return null;
    }
    if (v === "slip") {
      s.step = "slip";
      return null;
    }
    if (v === "bank") {
      s.step = "bank";
      return null;
    }
    if (v.startsWith("e:")) {
      d.empId = v.slice(2);
      d.slipId = null;
      s.step = "slip";
      return null;
    }
    if (v.startsWith("s:")) {
      d.slipId = v.slice(2);
      s.step = d.bankId ? "confirm" : "bank";
      return null;
    }
    if (v.startsWith("b:")) {
      d.bankId = v.slice(2);
      s.step = d.slipId ? "confirm" : "slip";
      return null;
    }
    if (v === "ok" && s.step === "confirm") {
      const slip = await prisma.payslip.findUnique({ where: { id: String(d.slipId) } });
      if (!slip) return "Slip tidak ditemukan";
      if (slip.paidAt) return "Slip ini sudah dibayar sebelumnya. Tidak dicatat dua kali.";
      const check = checkAmount(d.read == null ? null : Number(d.read), Number(slip.total));
      if (!check.ok) return check.text.replace(/<[^>]+>/g, "");
      try {
        const r = await paySlip(slip.id, String(d.bankId), null, { id: ctx.i.userId, name: ctx.i.user.name }, jakartaDateTime(String(d.date), String(d.time ?? "12:00")), { messageId: d.msgId ? String(d.msgId) : null, proofPath: d.proofPath ? String(d.proofPath) : null });
        d.journal = r.journal?.number ?? null;
        d.paid = Number(slip.total);
        d.done = r.done ? "1" : null;
        d.code = r.code;
        return "done";
      } catch (e) {
        return e instanceof PayrollError ? e.message : (e as Error).message.slice(0, 200);
      }
    }
    return "Pilih dengan tombol di atas";
  },
  async finish(_ctx, s) {
    const d = s.data;
    if (s.step === "used") return { text: "Tidak ada yang dicatat.", buttons: [menuBtn] };
    const emp = await prisma.employee.findUnique({ where: { id: String(d.empId) }, select: { name: true } });
    const bank = await prisma.bankAccount.findUnique({ where: { id: String(d.bankId) }, select: { name: true } });
    return {
      text: `✅ <b>Gaji ${esc(emp?.name ?? "")} ${esc(String(d.code))} lunas</b>\nDibayar ${idr(Number(d.paid))} dari ${esc(bank?.name ?? "-")}${d.journal ? ` · jurnal ${esc(String(d.journal))}` : ""}\nHutang Gaji dilunasi (bukan beban baru).${d.done ? `\nSemua slip ${esc(String(d.code))} sudah lunas 🎉` : ""}`,
      buttons: [menuBtn],
    };
  },
};
