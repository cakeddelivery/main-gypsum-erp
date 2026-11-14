import { prisma } from "./db";
import { toEntries, type ChecklistEntry } from "./shiftReport";

/** Checklist bawaan bila divisi belum punya checklist sendiri (setting report_checklist, lalu daftar umum) */
export const DEFAULT_CHECKLIST = ["Area kerja bersih & rapi", "Peralatan/cetakan dicek", "Bahan cukup untuk shift berikutnya", "Hasil sudah dihitung ulang", "Reject dipisahkan & dicatat"];

/** Checklist yang berlaku untuk divisi: checklist divisi yang diatur Owner; kosong → bawaan */
export async function divisionChecklist(division: { checklist: unknown }): Promise<ChecklistEntry[]> {
  const own = toEntries(division.checklist);
  if (own.length) return own;
  const setting = await prisma.setting.findUnique({ where: { key: "report_checklist" } });
  return toEntries(setting ? setting.value.split("\n").map((s) => s.trim()).filter(Boolean) : DEFAULT_CHECKLIST);
}

/**
 * Susun ulang checklist draf mengikuti checklist divisi terbaru (urutan, label, wajib foto).
 * Jawaban lama (centang & foto) dipertahankan bila labelnya sama (huruf besar/kecil & spasi diabaikan).
 */
export function mergeChecklist(target: ChecklistEntry[], current: ChecklistEntry[]): ChecklistEntry[] {
  const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const old = new Map(current.map((c) => [key(c.label), c]));
  return target.map((t) => {
    const o = old.get(key(t.label));
    return { label: t.label, photo: t.photo, done: o ? (t.photo ? !!o.photoPath : o.done) : false, photoPath: o?.photoPath ?? null };
  });
}

const same = (a: ChecklistEntry[], b: ChecklistEntry[]) => JSON.stringify(a) === JSON.stringify(b);

/** Perbarui checklist laporan yang masih DRAF agar sama dengan checklist divisi; laporan terkirim tidak diubah */
export async function refreshDraftChecklists(where: { id?: string; divisionId?: string }) {
  const drafts = await prisma.shiftReport.findMany({ where: { ...where, status: "DRAFT" }, include: { division: true } });
  let n = 0;
  for (const r of drafts) {
    const cur = toEntries(r.checklist);
    const next = mergeChecklist(await divisionChecklist(r.division), cur);
    if (same(cur, next)) continue;
    await prisma.shiftReport.update({ where: { id: r.id }, data: { checklist: next } });
    n++;
  }
  return n;
}
