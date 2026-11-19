import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDay, todayStr } from "@/lib/time";
import { TERMINATION_REASONS, type TerminationReason } from "@/lib/terminationCalc";
import { Badge, Empty, Field, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import { createTerminationAction } from "./actions";

export const metadata = { title: "Pengakhiran kontrak" };
const ST = { DRAFT: ["Draf", "gray"], DITERBITKAN: ["Diterbitkan", "green"], BATAL: ["Batal", "red"] } as const;

export default async function PengakhiranPage() {
  await requirePerm("hrd.manage");
  const [rows, emps] = await Promise.all([
    prisma.termination.findMany({ orderBy: [{ year: "desc" }, { seq: "desc" }], include: { employee: { select: { name: true, division: { select: { name: true } } } } }, take: 200 }),
    prisma.employee.findMany({ where: { status: "AKTIF", contracts: { some: { status: "AKTIF", kind: "PKWT" } } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Pengakhiran kontrak"
        subtitle="Resign, pelanggaran berat, kontrak habis, atau diputus perusahaan: slip akhir otomatis + Surat bernomor dengan QR HRD"
        actions={<>
          <Link href="/kontrak" className="btn-secondary">Kontrak</Link>
          <Modal trigger="+ Akhiri kontrak" title="Akhiri kontrak">
            <ModalForm action={createTerminationAction} className="space-y-3">
              <Field label="Karyawan"><select name="employeeId" className="input" required><option value="">— pilih —</option>{emps.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
              <Field label="Alasan"><select name="reason" className="input" required>{Object.entries(TERMINATION_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="Berlaku efektif"><input type="date" name="effective" className="input" required defaultValue={todayStr()} /></Field>
              <Field label="Kerugian perusahaan yang terbukti (Rp, khusus pelanggaran berat)"><input name="damage" className="input" inputMode="numeric" defaultValue="0" /></Field>
              <Field label="Uraian / catatan"><textarea name="note" className="input" rows={3} maxLength={1000} placeholder="Kronologi singkat, hasil klarifikasi, dsb." /></Field>
              <Field label="Lampiran bukti (foto/PDF, wajib bila pelanggaran berat tanpa uraian)"><input type="file" name="evidence" accept="image/*,application/pdf" className="block w-full min-w-0 max-w-full text-sm" /></Field>
              <p className="text-xs text-slate-500">Slip akhir dihitung otomatis dari kontrak terkunci dan absensi. Draf bisa diperiksa dulu sebelum surat diterbitkan.</p>
              <Submit>Buat draf pengakhiran</Submit>
            </ModalForm>
          </Modal>
        </>}
      />
      {rows.length ? (
        <div className="table-wrap">
          <Paged>
            <table className="tbl">
              <thead><tr><th>Nomor</th><th>Karyawan</th><th>Alasan</th><th>Efektif</th><th className="num">Dibayarkan</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/kontrak/pengakhiran/${r.id}`} className="link font-mono text-xs">{r.number}</Link></td>
                    <td>{r.employee.name}<div className="text-xs text-slate-500">{r.employee.division.name}</div></td>
                    <td className="text-xs">{TERMINATION_REASONS[r.reason as TerminationReason]}</td>
                    <td className="text-xs">{fmtDay(r.effectiveDate)}</td>
                    <td className="num">{idr((r.calc as unknown as { net: number }).net)}</td>
                    <td><Badge tone={ST[r.status][1]}>{ST[r.status][0]}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Paged>
        </div>
      ) : (
        <Empty title="Belum ada pengakhiran kontrak" hint="Hanya karyawan dengan kontrak PKWT terkunci yang bisa diakhiri." />
      )}
    </div>
  );
}
