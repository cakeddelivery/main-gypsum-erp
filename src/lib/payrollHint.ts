import { prisma } from "./db";
import { idr } from "./money";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PAY_WORDS = /\b(gaji|gajian|upah|slip)\b/i;

/**
 * Pesan bot "Gaji Rico periode oktober 1.250.000": cari karyawan yang disebut. Bila gajinya sudah ada di menu
 * Penggajian dengan status Disetujui (sudah dibukukan sebagai Hutang Gaji, belum dibayar), draft ini TIDAK boleh
 * dibukukan sebagai beban lagi (beban gaji tercatat dua kali): beri peringatan untuk membayar lewat menu Penggajian.
 * Selain itu draft dicatat sebagai pengeluaran kategori Gaji & Upah seperti biasa.
 */
export async function payrollHint(text: string | null | undefined): Promise<{ text: string; warn: boolean } | null> {
  if (!text || !PAY_WORDS.test(text)) return null;
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const emps = await prisma.employee.findMany({ where: { status: { not: "NONAKTIF" } }, select: { id: true, name: true, nickname: true } });
  const hit = emps.filter((e) => [e.nickname, ...e.name.split(/\s+/)].some((w) => !!w && w.length >= 3 && t.includes(` ${w.toLowerCase()} `)));
  if (hit.length !== 1) return null;
  const e = hit[0];
  const slips = await prisma.payslip.findMany({ where: { employeeId: e.id, period: { status: "DISETUJUI" } }, include: { period: { select: { code: true } } } });
  const due = slips.filter((s) => Number(s.total) > 0);
  if (due.length) {
    const list = due.map((s) => `${s.period.code} ${idr(s.total)}`).join(", ");
    return { warn: true, text: `⚠️ <b>Gaji ${esc(e.name)} sudah tercatat di Penggajian</b> (${list}, disetujui, belum dibayar). Agar beban gaji tidak tercatat dua kali, bayar lewat web: Penggajian → ${due[0].period.code} → Bayar, lalu tolak draft ini.` };
  }
  return { warn: false, text: `👤 Gaji karyawan: ${esc(e.name)} (tidak ada slip disetujui yang belum dibayar, dicatat sebagai beban Gaji & Upah)` };
}
