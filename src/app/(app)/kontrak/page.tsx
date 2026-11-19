import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { contractSettings, canManageContracts } from "@/lib/contract";
import { addDays, dateStr, fmtDay, todayStr } from "@/lib/time";
import { Badge, Empty, Field, PageHeader, Tabs } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import { createContractAction, saveContractSettingsAction } from "./actions";
import { ClauseEditor } from "./ClauseEditor";
import { ContractFields } from "./ContractFields";

export const metadata = { title: "Kontrak kerja" };

const STATUS = { DRAFT: { label: "Draf", tone: "gray" }, HRD_TTD: { label: "Menunggu karyawan", tone: "amber" }, AKTIF: { label: "Terkunci", tone: "green" }, BATAL: { label: "Batal", tone: "red" } } as const;

export default async function KontrakPage({ searchParams }: { searchParams: Promise<{ tab?: string; status?: string }> }) {
  const user = await requirePerm("hrd.manage", "payroll.self");
  const sp = await searchParams;
  const hrd = canManageContracts(user);
  const tab = hrd && sp.tab === "pengaturan" ? "pengaturan" : "kontrak";
  const tabs = hrd ? [{ key: "kontrak", label: "Kontrak", href: "/kontrak" }, { key: "pengaturan", label: "Pengaturan kontrak", href: "/kontrak?tab=pengaturan" }] : [];
  const statusFilter = sp.status && sp.status in STATUS ? (sp.status as keyof typeof STATUS) : null;
  const rows = await prisma.contract.findMany({
    where: hrd ? (statusFilter ? { status: statusFilter } : {}) : { employeeId: user.employeeId ?? "-", status: { in: ["HRD_TTD", "AKTIF"] } },
    orderBy: [{ year: "desc" }, { seq: "desc" }],
    include: { employee: { select: { name: true, division: { select: { name: true } } } } },
    take: 200,
  });
  const today = todayStr();
  return (
    <div className="space-y-5">
      <PageHeader title="Kontrak kerja" subtitle={hrd ? "Perjanjian kerja digital: dibuat dari data karyawan, ditandatangani HRD (QR) dan karyawan (di HP)" : "Kontrak kerja Anda"} />
      {tabs.length > 0 && <Tabs current={tab} tabs={tabs} />}
      {tab === "kontrak" && (
        <>
          {hrd && <HrdBar today={today} />}
          {!hrd && rows.some((r) => r.status === "HRD_TTD") && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Ada kontrak yang menunggu tanda tangan Anda. Ketuk kontraknya, baca, lalu tandatangani.</p>}
          {rows.length ? (
            <div className="table-wrap">
              <Paged>
                <table className="tbl">
                  <thead><tr><th>Nomor</th><th>Karyawan</th><th>Jenis</th><th>Masa kerja</th><th>Status</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td><Link href={`/kontrak/${r.id}`} className="link font-mono text-xs">{r.number}</Link></td>
                        <td>{r.employee.name}<div className="text-xs text-slate-500">{r.employee.division.name}</div></td>
                        <td>{r.kind === "ADD" ? "Addendum" : "PKWT"}</td>
                        <td className="text-xs">{fmtDay(r.startDate)} – {fmtDay(r.endDate)}{r.status === "AKTIF" && dateStr(r.endDate) < today && <Badge tone="gray">berakhir</Badge>}</td>
                        <td><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Paged>
            </div>
          ) : (
            <Empty title="Belum ada kontrak" hint={hrd ? "Ketuk “+ Buat kontrak” untuk membuat dari data karyawan." : "Kontrak akan muncul di sini setelah HRD menandatanganinya."} />
          )}
        </>
      )}
      {tab === "pengaturan" && <Settings />}
    </div>
  );
}

async function HrdBar({ today }: { today: string }) {
  const [st, emps] = await Promise.all([
    contractSettings(),
    prisma.employee.findMany({ where: { status: "AKTIF" }, orderBy: { name: "asc" }, select: { id: true, name: true, nik: true, address: true, monthlySalary: true, division: { select: { name: true } } } }),
  ]);
  return (
    <div className="flex flex-wrap gap-2">
      <Modal trigger="+ Buat kontrak" title="Buat kontrak kerja (draf)">
        <ModalForm action={createContractAction} className="space-y-3">
          <ContractFields mode="create" durations={st.durations} today={today} employees={emps.map((e) => ({ id: e.id, name: `${e.name} · ${e.division.name}`, nik: e.nik ?? "", address: e.address ?? "", salary: Number(e.monthlySalary) }))} />
          <Submit>Buat draf</Submit>
        </ModalForm>
      </Modal>
    </div>
  );
}

async function Settings() {
  const st = await contractSettings();
  return (
    <ActionForm action={saveContractSettingsAction} className="mx-auto max-w-3xl space-y-5">
      <section className="card space-y-3 p-4">
        <h3 className="font-bold text-slate-800">Penandatangan & aturan umum</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nama penandatangan HRD"><input name="hrdName" className="input" defaultValue={st.hrd.name} required /></Field>
          <Field label="Jabatan"><input name="hrdTitle" className="input" defaultValue={st.hrd.title} /></Field>
          <Field label="Lama kontrak yang ditawarkan (bulan, pisah koma)"><input name="durations" className="input" defaultValue={st.durations.join(",")} inputMode="numeric" required /></Field>
          <Field label="Masa pemberitahuan resign (hari)"><input name="resignDays" className="input" type="number" min={0} max={365} defaultValue={st.resignDays} required /></Field>
          <Field label="BPJS TK ditanggung perusahaan mulai (YYYY-MM)"><input name="bpjsSince" className="input" defaultValue={st.bpjsSince} pattern="\d{4}-\d{2}" required /></Field>
        </div>
        <p className="text-xs text-slate-500">Gaji pokok, tunjangan (beserta tanggal bayar), dan jadwal shift diambil otomatis dari data karyawan saat kontrak dibuat.</p>
      </section>
      <section className="card space-y-3 p-4">
        <h3 className="font-bold text-slate-800">Template pasal</h3>
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Pasal 5 (Pengunduran Diri) masih <b>draf</b> menunggu konfirmasi akhir Owner dan sebaiknya ditinjau ahli hukum (ganti rugi dikompensasi dengan upah terutang).</p>
        <ClauseEditor initial={st.clauses} />
      </section>
      <Submit>Simpan pengaturan</Submit>
    </ActionForm>
  );
}
