import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, Card, Field, PageHeader, Tabs } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ActionForm, Submit } from "@/components/ActionForm";
import { saveBank, saveCategory, saveDivision, saveOrg, saveParams, saveShift, saveStore } from "./actions";

export const metadata = { title: "Pengaturan" };

export default async function PengaturanPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requirePerm("settings.manage", "users.manage", "telegram.manage", "audit.view");
  if (!user.can("settings.manage")) redirect(user.can("users.manage") ? "/pengaturan/pengguna" : user.can("telegram.manage") ? "/pengaturan/telegram" : "/pengaturan/audit");
  const { tab = "organisasi" } = await searchParams;
  const [org, stores, divisions, shifts, banks, cats, cashAcc, catAcc, settings, locations] = await Promise.all([
    prisma.organization.findFirst(),
    prisma.store.findMany({ orderBy: { code: "asc" } }),
    prisma.division.findMany({ orderBy: { code: "asc" } }),
    prisma.shift.findMany({ orderBy: { code: "asc" } }),
    prisma.bankAccount.findMany({ include: { coaAccount: true }, orderBy: { code: "asc" } }),
    prisma.txCategory.findMany({ include: { coaAccount: true }, orderBy: [{ direction: "asc" }, { name: "asc" }] }),
    prisma.coaAccount.findMany({ where: { isCash: true }, orderBy: { code: "asc" } }),
    prisma.coaAccount.findMany({ where: { isCash: false, active: true }, orderBy: { code: "asc" } }),
    prisma.setting.findMany(),
    prisma.location.findMany({ orderBy: { code: "asc" } }),
  ]);
  const s = (k: string) => settings.find((x) => x.key === k)?.value ?? "";
  const links = (
    <>
      {user.can("users.manage") && <Link href="/pengaturan/pengguna" className="btn-secondary">Pengguna & hak akses</Link>}
      {user.can("telegram.manage") && <Link href="/pengaturan/telegram" className="btn-secondary">Telegram & Hermes</Link>}
      {user.can("audit.view") && <Link href="/pengaturan/audit" className="btn-secondary">Audit trail</Link>}
      <Link href="/pengaturan/sistem" className="btn-secondary">Sistem</Link>
    </>
  );
  const T = [
    { key: "organisasi", label: "Organisasi & toko" },
    { key: "divisi", label: "Divisi" },
    { key: "shift", label: "Shift" },
    { key: "rekening", label: "Rekening" },
    { key: "kategori", label: "Kategori transaksi" },
    { key: "parameter", label: "Parameter operasional" },
  ].map((t) => ({ ...t, href: `?tab=${t.key}` }));

  const storeForm = (x?: (typeof stores)[number]) => (
    <ModalForm action={saveStore} className="space-y-3">{x && <input type="hidden" name="id" value={x.id} />}<Field label="Kode"><input name="code" defaultValue={x?.code} className="input" required /></Field><Field label="Nama"><input name="name" defaultValue={x?.name} className="input" required /></Field>{x && <label className="flex gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={x.active} /> Aktif</label>}<Submit>Simpan</Submit></ModalForm>
  );
  const divForm = (x?: (typeof divisions)[number]) => (
    <ModalForm action={saveDivision} className="space-y-3">{x && <input type="hidden" name="id" value={x.id} />}<Field label="Kode"><input name="code" defaultValue={x?.code} className="input" required /></Field><Field label="Nama"><input name="name" defaultValue={x?.name} className="input" required /></Field>{x && <label className="flex gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={x.active} /> Aktif</label>}<Submit>Simpan</Submit></ModalForm>
  );
  const shiftForm = (x?: (typeof shifts)[number]) => (
    <ModalForm action={saveShift} className="grid grid-cols-2 gap-3">{x && <input type="hidden" name="id" value={x.id} />}<Field label="Kode"><input name="code" defaultValue={x?.code} className="input" required /></Field><Field label="Nama"><input name="name" defaultValue={x?.name} className="input" required /></Field><Field label="Mulai"><input type="time" name="startTime" defaultValue={x?.startTime} className="input" required /></Field><Field label="Selesai"><input type="time" name="endTime" defaultValue={x?.endTime} className="input" required /></Field><Field label="Toleransi (menit)"><input name="toleranceMinutes" defaultValue={x?.toleranceMinutes ?? 10} inputMode="numeric" className="input" /></Field>{x && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={x.active} /> Aktif</label>}<div className="col-span-2"><Submit>Simpan</Submit></div></ModalForm>
  );
  const bankForm = (x?: (typeof banks)[number]) => (
    <ModalForm action={saveBank} className="space-y-3">{x && <input type="hidden" name="id" value={x.id} />}<Field label="Kode"><input name="code" defaultValue={x?.code} className="input" required /></Field><Field label="Nama"><input name="name" defaultValue={x?.name} className="input" required /></Field><Field label="Akun COA (kas/bank)"><select name="coaAccountId" defaultValue={x?.coaAccountId} className="input">{cashAcc.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field><Field label="Alias untuk ekstraksi (pisahkan koma)"><input name="aliases" defaultValue={x?.aliases} className="input" /></Field>{x && <label className="flex gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={x.active} /> Aktif</label>}<Submit>Simpan</Submit></ModalForm>
  );
  const catForm = (x?: (typeof cats)[number]) => (
    <ModalForm action={saveCategory} className="space-y-3">{x && <input type="hidden" name="id" value={x.id} />}<Field label="Nama"><input name="name" defaultValue={x?.name} className="input" required /></Field><Field label="Jenis"><select name="direction" defaultValue={x?.direction} className="input"><option value="MASUK">Pemasukan</option><option value="KELUAR">Pengeluaran</option></select></Field><Field label="Akun COA"><select name="coaAccountId" defaultValue={x?.coaAccountId} className="input">{catAcc.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field><Field label="Kata kunci rekomendasi (pisahkan koma)"><input name="keywords" defaultValue={x?.keywords} className="input" /></Field>{x && <label className="flex gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={x.active} /> Aktif</label>}<Submit>Simpan</Submit></ModalForm>
  );
  const add: Record<string, React.ReactNode> = {
    organisasi: <Modal trigger="+ Toko" title="Toko baru">{storeForm()}</Modal>,
    divisi: <Modal trigger="+ Divisi" title="Divisi baru">{divForm()}</Modal>,
    shift: <Modal trigger="+ Shift" title="Shift baru">{shiftForm()}</Modal>,
    rekening: <Modal trigger="+ Rekening" title="Rekening baru">{bankForm()}</Modal>,
    kategori: <Modal trigger="+ Kategori" title="Kategori baru">{catForm()}</Modal>,
  };
  const edit = (node: React.ReactNode, title: string) => <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={title}>{node}</Modal>;
  const active = (a: boolean) => (a ? <Badge tone="green">Aktif</Badge> : <Badge>Nonaktif</Badge>);
  return (
    <div className="space-y-4">
      <PageHeader title="Pengaturan" subtitle="Organisasi, toko, divisi, shift, rekening, kategori, dan parameter operasional" actions={links} />
      <Tabs current={tab} tabs={T} />
      {add[tab] && <div className="flex justify-end">{add[tab]}</div>}
      {tab === "organisasi" && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Organisasi"><ActionForm action={saveOrg} className="space-y-3"><Field label="Nama organisasi"><input name="name" defaultValue={org?.name} className="input" /></Field><p className="text-xs text-slate-500">Mata uang: IDR (tetap) · Zona waktu: Asia/Jakarta (WIB, tetap)</p><Submit>Simpan</Submit></ActionForm></Card>
          <Card title="Toko"><table className="tbl"><tbody>{stores.map((x) => <tr key={x.id}><td className="font-mono text-xs">{x.code}</td><td>{x.name}</td><td>{active(x.active)}</td><td>{edit(storeForm(x), "Ubah toko")}</td></tr>)}</tbody></table></Card>
        </div>
      )}
      {tab === "divisi" && <div className="table-wrap"><table className="tbl"><thead><tr><th>Kode</th><th>Nama</th><th>Status</th><th /></tr></thead><tbody>{divisions.map((x) => <tr key={x.id}><td className="font-mono text-xs">{x.code}</td><td>{x.name}</td><td>{active(x.active)}</td><td>{edit(divForm(x), "Ubah divisi")}</td></tr>)}</tbody></table></div>}
      {tab === "shift" && <div className="table-wrap"><table className="tbl"><thead><tr><th>Kode</th><th>Nama</th><th>Jam</th><th>Toleransi</th><th>Status</th><th /></tr></thead><tbody>{shifts.map((x) => <tr key={x.id}><td className="font-mono text-xs">{x.code}</td><td>{x.name}</td><td>{x.startTime}–{x.endTime} WIB</td><td>{x.toleranceMinutes} menit</td><td>{active(x.active)}</td><td>{edit(shiftForm(x), "Ubah shift")}</td></tr>)}</tbody></table></div>}
      {tab === "rekening" && <div className="table-wrap"><table className="tbl"><thead><tr><th>Kode</th><th>Nama</th><th>Akun COA</th><th>Alias</th><th>Status</th><th /></tr></thead><tbody>{banks.map((x) => <tr key={x.id}><td className="font-mono text-xs">{x.code}</td><td>{x.name}</td><td>{x.coaAccount.code} {x.coaAccount.name}</td><td className="text-xs">{x.aliases}</td><td>{active(x.active)}</td><td>{edit(bankForm(x), "Ubah rekening")}</td></tr>)}</tbody></table></div>}
      {tab === "kategori" && <div className="table-wrap"><table className="tbl"><thead><tr><th>Nama</th><th>Jenis</th><th>Akun COA</th><th>Kata kunci</th><th>Status</th><th /></tr></thead><tbody>{cats.map((x) => <tr key={x.id}><td>{x.name}</td><td><Badge tone={x.direction === "MASUK" ? "green" : "red"}>{x.direction}</Badge></td><td>{x.coaAccount.code} {x.coaAccount.name}</td><td className="max-w-xs truncate text-xs">{x.keywords}</td><td>{active(x.active)}</td><td>{edit(catForm(x), "Ubah kategori")}</td></tr>)}</tbody></table></div>}
      {tab === "parameter" && (
        <Card title="Parameter operasional">
          <ActionForm action={saveParams} className="grid gap-3 md:grid-cols-2">
            <Field label="Toko default transaksi"><select name="default_store_id" defaultValue={s("default_store_id")} className="input">{stores.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="Lokasi bahan baku (konsumsi produksi)"><select name="loc_raw" defaultValue={s("loc_raw")} className="input">{locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="Lokasi barang dalam proses"><select name="loc_wip" defaultValue={s("loc_wip")} className="input">{locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="Lokasi barang jadi (hasil produksi)"><select name="loc_finished" defaultValue={s("loc_finished")} className="input">{locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="Potongan keterlambatan per menit (IDR)"><input name="late_deduction_per_minute" defaultValue={s("late_deduction_per_minute")} inputMode="numeric" className="input" /></Field>
            <Field label="Gajian H+ berapa hari setelah siklus selesai"><input name="payday_offset_days" defaultValue={s("payday_offset_days") || "7"} inputMode="numeric" className="input" /></Field>
            <Field label="Jatah libur per minggu (hari)" hint="Lebih dari ini dihitung bolos"><input name="weekly_off_quota" defaultValue={s("weekly_off_quota") || "1"} inputMode="numeric" className="input" /></Field>
            <Field label="Hari kerja per bulan (dasar potongan bolos)" hint="Potongan/hari = gaji bulanan ÷ angka ini"><input name="monthly_workdays" defaultValue={s("monthly_workdays") || "26"} inputMode="numeric" className="input" /></Field>
            <Field label="Gaji hanya dari absensi tervalidasi"><select name="payroll_require_validated" defaultValue={s("payroll_require_validated") || "true"} className="input"><option value="true">Ya</option><option value="false">Tidak</option></select></Field>
            <Field label="Tutup buku otomatis (tgl 1, 09.00 WIB)"><select name="auto_close_enabled" defaultValue={s("auto_close_enabled") || "true"} className="input"><option value="true">Aktif</option><option value="false">Nonaktif</option></select></Field>
            <Field label="Alamat perusahaan"><input name="company_address" defaultValue={s("company_address")} className="input" /></Field>
            <Field label="Checklist laporan shift (satu per baris)" className="md:col-span-2"><textarea name="report_checklist" rows={5} defaultValue={s("report_checklist") || "Area kerja bersih & rapi\nPeralatan/cetakan dicek\nBahan cukup untuk shift berikutnya\nHasil sudah dihitung ulang\nReject dipisahkan & dicatat"} className="input" /></Field>
            <div className="md:col-span-2"><Submit>Simpan parameter</Submit></div>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
