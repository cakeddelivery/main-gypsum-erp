import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { REPORT_TEMPLATES, TEMPLATES, toEntries } from "@/lib/shiftReport";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Badge, Card, Empty, Field, PageHeader, Tabs } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ChecklistEditor } from "./ChecklistEditor";
import { deleteMaterial, saveDivision, saveMaterial } from "./actions";

export const metadata = { title: "Bahan Baku & Checklist Divisi" };

export default async function BahanDivisiPage({ searchParams }: { searchParams: Promise<{ div?: string }> }) {
  await requirePerm("material.manage");
  const sp = await searchParams;
  const divisions = await prisma.division.findMany({ orderBy: [{ active: "desc" }, { code: "asc" }], include: { _count: { select: { items: { where: { active: true } } } } } });
  const current = divisions.find((d) => d.id === sp.div) ?? divisions.find((d) => d.reportTemplate && d.active) ?? divisions[0];
  const items = current ? await prisma.item.findMany({ where: { divisionId: current.id, active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }) : [];

  const matForm = (i?: (typeof items)[number]) => (
    <ModalForm action={saveMaterial} className="grid grid-cols-2 gap-3">
      {i && <input type="hidden" name="id" value={i.id} />}
      <input type="hidden" name="divisionId" value={current!.id} />
      <Field label="Nama bahan" className="col-span-2"><input name="name" defaultValue={i?.name} className="input" required /></Field>
      <Field label="Satuan"><input name="unit" defaultValue={i?.unit ?? "pcs"} className="input" placeholder="pcs, sak, roll, kg…" required /></Field>
      <Field label="Limit (order bila stok ≤ limit)"><input name="limit" defaultValue={i ? Number(i.minStock) : ""} inputMode="decimal" className="input" required /></Field>
      <Field label="Urutan" hint="Kosongkan untuk taruh di akhir"><input name="sortOrder" defaultValue={i?.sortOrder ?? ""} inputMode="numeric" className="input" /></Field>
      <div className="col-span-2 flex justify-end"><Submit>Simpan</Submit></div>
    </ModalForm>
  );
  const divForm = (d?: (typeof divisions)[number]) => (
    <ModalForm action={saveDivision} className="space-y-3">
      {d && <input type="hidden" name="id" value={d.id} />}
      {!d && <Field label="Kode"><input name="code" className="input" placeholder="mis. PRD" required /></Field>}
      <Field label="Nama divisi"><input name="name" defaultValue={d?.name} className="input" required /></Field>
      <Field label="Format laporan shift">
        <select name="reportTemplate" defaultValue={d?.reportTemplate ?? ""} className="input">
          <option value="">Umum (tanpa detail hasil kerja)</option>
          {REPORT_TEMPLATES.map((t) => <option key={t} value={t}>{TEMPLATES[t].label}</option>)}
        </select>
      </Field>
      <Field label="Jumlah shift">
        <select name="shiftCount" defaultValue={String(d?.shiftCount ?? 1)} className="input"><option value="1">1 shift (Shift 1 saja)</option><option value="2">2 shift</option></select>
      </Field>
      {d && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={d.active} className="h-4 w-4" /> Aktif (tampil di laporan shift)</label>}
      <Submit>Simpan</Submit>
    </ModalForm>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Bahan baku & checklist divisi"
        subtitle="Bahan baku tiap divisi untuk stock opname di laporan shift, limit order, dan checklist penutupan"
        actions={<><Modal trigger="+ Divisi" title="Divisi baru">{divForm()}</Modal></>}
      />
      <Tabs current={current?.id ?? ""} tabs={divisions.map((d) => ({ key: d.id, label: d.active ? d.name : `${d.name} (nonaktif)`, href: `?div=${d.id}`, count: d._count.items }))} />
      {!current ? <Empty title="Belum ada divisi" /> : (
        <div className="grid gap-4 lg:grid-cols-5">
          <Card
            className="lg:col-span-3"
            title={`Bahan baku ${current.name}`}
            actions={<Modal trigger="+ Bahan" triggerClass="btn-primary btn-sm" title={`Bahan baru · ${current.name}`}>{matForm()}</Modal>}
          >
            {items.length === 0 ? <Empty title="Belum ada bahan baku" hint="Tambahkan bahan yang dihitung divisi ini setiap tutup shift" /> : (
              <ul className="divide-y divide-slate-100">
                {items.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{i.name}</div>
                      <div className="text-xs text-slate-500">Limit {Number(i.minStock).toLocaleString("id-ID")} {i.unit} · <span className="font-mono">{i.sku}</span></div>
                    </div>
                    <div className="flex gap-1.5">
                      <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah bahan">{matForm(i)}</Modal>
                      <ActionForm action={deleteMaterial} confirm={`Hapus ${i.name} dari bahan baku ${current.name}?`}>
                        <input type="hidden" name="id" value={i.id} />
                        <Submit className="btn-secondary btn-sm text-rose-600" pendingText="…">Hapus</Submit>
                      </ActionForm>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="space-y-4 lg:col-span-2">
            <Card title="Divisi" actions={<Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah divisi">{divForm(current)}</Modal>}>
              <div className="space-y-1 text-sm">
                <div>{current.name} <span className="font-mono text-xs text-slate-400">{current.code}</span></div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={current.reportTemplate ? "blue" : "gray"}>Format: {current.reportTemplate ? TEMPLATES[current.reportTemplate as keyof typeof TEMPLATES]?.label ?? current.reportTemplate : "Umum"}</Badge>
                  <Badge>{current.shiftCount} shift</Badge>
                  <Badge tone={current.active ? "green" : "red"}>{current.active ? "Aktif" : "Nonaktif"}</Badge>
                </div>
              </div>
            </Card>
            <Card title="Checklist penutupan shift" actions={
              <Modal trigger="Ubah checklist" triggerClass="btn-primary btn-sm" title={`Checklist · ${current.name}`} wide>
                <ChecklistEditor key={current.id} divisionId={current.id} initial={toEntries(current.checklist).map(({ label, photo }) => ({ label, photo }))} />
              </Modal>
            }>
              {toEntries(current.checklist).length === 0 ? <p className="text-sm text-slate-500">Belum ada checklist.</p> : (
                <ol className="space-y-1.5 text-sm">
                  {toEntries(current.checklist).map((c, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2"><span>{i + 1}. {c.label}</span>{c.photo && <Badge tone="blue">wajib foto</Badge>}</li>
                  ))}
                </ol>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
