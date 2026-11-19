import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { dateOnly, fmtDay, todayStr } from "@/lib/time";
import { STAGES, STAGE_LABEL } from "@/lib/stock";
import { Card, Empty, FilterBar, PageHeader, Field } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ActionForm, Submit } from "@/components/ActionForm";
import { EntryForm } from "./EntryForm";
import { deleteEntry } from "./actions";
import type { Prisma } from "@prisma/client";
import { Paged } from "@/components/Paged";
import { DownloadCsv } from "@/components/DownloadCsv";
import { alurProduksi, BOX_LABEL, BOX_ORDER, type BoxKey } from "@/lib/alurProduksi";
import type { ProductionStage } from "@prisma/client";

export const metadata = { title: "Produksi" };

/** Filter tahap (tahap yang berlaku sekarang) → tahap lama di input manual */
const STAGE_FILTER: Record<BoxKey, ProductionStage[]> = {
  CETAK: ["CETAK"],
  OVEN: ["OVEN", "PANEN_1", "PANEN_2", "SORTIR_1", "SORTIR_2"],
  BORONGAN: ["ASSEMBLING", "FILLING_CAT"],
  PACKING: ["PACKING", "QC", "BARANG_JADI"],
  GIFTBOX: [],
};

export default async function ProduksiPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePerm("production.view");
  const sp = await searchParams;
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayStr();
  const isOp = user.role === "OPERATOR";
  const fixedDivision = user.role === "KAPTEN_DIVISI" ? user.divisionId : null;
  const where: Prisma.ProductionEntryWhereInput = {
    date: dateOnly(date),
    ...(sp.shift ? { shiftId: sp.shift } : {}),
    ...(fixedDivision ? { divisionId: fixedDivision } : sp.division ? { divisionId: sp.division } : {}),
    ...(sp.stage && sp.stage in STAGE_FILTER ? { stage: { in: STAGE_FILTER[sp.stage as BoxKey] } } : {}),
    ...(isOp ? { employeeId: user.employeeId ?? "__none__" } : {}),
  };
  const box = sp.box && (BOX_ORDER as string[]).includes(sp.box) ? (sp.box as BoxKey) : null;
  const isOwner = user.role === "OWNER";
  const [alur, entries, shifts, divisions, employees, products] = await Promise.all([
    alurProduksi({ date, shiftId: sp.shift || null, divisionId: fixedDivision ?? (sp.division || null) }),
    prisma.productionEntry.findMany({ where, include: { shift: true, division: true, employee: true, product: true }, orderBy: { createdAt: "desc" }, take: 300 }),
    prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.division.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.employee.findMany({ where: { status: "AKTIF" }, orderBy: { name: "asc" } }),
    prisma.product.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
  ]);
  const totalGood = entries.reduce((s, e) => s + e.qtyGood, 0);
  const totalReject = entries.reduce((s, e) => s + e.qtyReject, 0);

  return (
    <div>
      <PageHeader
        title="Produksi"
        subtitle={`Alur produksi ${fmtDay(dateOnly(date))} · dibaca dari laporan shift & borongan`}
        actions={
          <>
            <DownloadCsv filename={`produksi-${date}`} rows={[["Alur produksi", "Tanggal", "Hasil", "Reject", "Stok tahap", "Sumber"], ...alur.map((b) => [b.label, date, b.good, b.reject, b.stock ?? "", b.from]), [], ["Tanggal", "Shift", "Divisi", "Karyawan", "Tahap", "Produk", "Hasil baik", "Reject", "Penyebab reject", "Catatan"], ...entries.map((e) => [date, e.shift.name, e.division.name, e.employee.name, STAGE_LABEL[e.stage], e.product.name, e.qtyGood, e.qtyReject, e.rejectReason ?? "", e.note ?? ""])]} />
            {user.can("production.target") && <Link href="/produksi/target" className="btn-secondary">Target</Link>}
            {isOwner && user.can("production.create") && (
              <Modal trigger="+ Koreksi hasil (Owner)" title="Koreksi hasil produksi (Owner)" subtitle="Hasil normal dicatat lewat Laporan Shift & Borongan; form ini hanya untuk koreksi" defaultOpen={sp.baru === "1"}>
                <EntryForm
                  date={date}
                  shifts={shifts}
                  divisions={divisions}
                  employees={employees}
                  products={products}
                  stages={STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] }))}
                  fixedEmployee={isOp ? user.employeeId : null}
                  fixedDivision={fixedDivision}
                />
              </Modal>
            )}
          </>
        }
      />

      <Card title="Alur produksi" className="mb-4">
        <ol className="flex gap-2 overflow-x-auto pb-1 text-xs">
          {alur.map((b, i) => {
            const q = new URLSearchParams({ date, ...(sp.shift ? { shift: sp.shift } : {}), ...(sp.division ? { division: sp.division } : {}), box: b.key });
            return (
              <li key={b.key} className="flex items-center gap-2">
                <Link href={`/produksi?${q}#sumber`} scroll={false} className={`block min-w-[132px] rounded-lg border px-2.5 py-2 ${box === b.key ? "border-brand-500 ring-2 ring-brand-200" : b.good || b.reject ? "border-brand-200 bg-brand-50" : "border-slate-200"}`}>
                  <div className="font-medium text-slate-700">{b.label}</div>
                  <div className="text-base font-bold tabular-nums text-slate-900">{b.good.toLocaleString("id-ID")} <span className="text-[11px] font-normal text-slate-500">{b.unit}</span></div>
                  <div className="tabular-nums text-rose-600">reject {b.reject.toLocaleString("id-ID")}</div>
                  <div className="tabular-nums text-slate-500">stok {b.stock == null ? "—" : Math.round(b.stock).toLocaleString("id-ID")}</div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400">{b.from}</div>
                </Link>
                {i < alur.length - 1 && <span className="text-slate-300">→</span>}
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-xs text-slate-500">Ketuk kotak untuk melihat laporan/kiriman sumbernya. Angka sama dengan detail hasil kerja di laporan shift tiap divisi.</p>
      </Card>
      {box && (() => {
        const b = alur.find((x) => x.key === box)!;
        return (
          <Card title={`Sumber · ${BOX_LABEL[box]}`} className="mb-4">
            <div id="sumber" className="space-y-3">
              {b.extras.length > 0 && <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">{b.extras.map((e) => <div key={e.label}><dt className="text-xs text-slate-500">{e.label}</dt><dd className="font-medium">{e.value}</dd></div>)}</dl>}
              {Object.keys(b.byVariant).length > 0 && <p className="text-sm text-slate-600">{Object.entries(b.byVariant).map(([k, v]) => `${k} ${v.toLocaleString("id-ID")}`).join(" · ")}</p>}
              {b.sources.length ? (
                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {b.sources.map((x, i) => <li key={i}><Link href={x.href} className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-50"><span className="font-medium text-brand-700">{x.label}</span><span className="text-xs text-slate-500">{x.detail}</span></Link></li>)}
                </ul>
              ) : <p className="text-sm text-slate-500">Belum ada laporan terkirim atau kiriman untuk filter ini.</p>}
            </div>
          </Card>
        );
      })()}

      <FilterBar>
        <Field label="Tanggal"><input type="date" name="date" defaultValue={date} className="input" /></Field>
        <Field label="Shift">
          <select name="shift" defaultValue={sp.shift ?? ""} className="input"><option value="">Semua</option>{shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </Field>
        {!fixedDivision && !isOp && (
          <Field label="Divisi">
            <select name="division" defaultValue={sp.division ?? ""} className="input"><option value="">Semua</option>{divisions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </Field>
        )}
        <Field label="Tahap">
          <select name="stage" defaultValue={sp.stage ?? ""} className="input"><option value="">Semua</option>{BOX_ORDER.map((s) => <option key={s} value={s}>{BOX_LABEL[s]}</option>)}</select>
        </Field>
      </FilterBar>

      {entries.length === 0 ? (
        <Empty title="Belum ada koreksi manual" hint="Hasil produksi masuk otomatis dari Laporan Shift dan Borongan. Daftar ini hanya berisi koreksi manual Owner." />
      ) : (
        <div className="table-wrap">
          <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Koreksi manual</p>
          <Paged><table className="tbl">
            <thead>
              <tr><th>Shift</th><th>Divisi</th><th>Karyawan</th><th>Tahap</th><th>Produk</th><th className="num">Hasil</th><th className="num">Reject</th><th>Catatan</th>{user.can("production.edit") && <th />}</tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.shift.name}</td>
                  <td>{e.division.name}</td>
                  <td>{e.employee.name}</td>
                  <td>{STAGE_LABEL[e.stage]}</td>
                  <td>{e.product.name}</td>
                  <td className="num">{e.qtyGood}</td>
                  <td className="num text-rose-600">{e.qtyReject}{e.rejectReason && <div className="text-[11px] font-normal text-slate-400">{e.rejectReason}</div>}</td>
                  <td className="min-w-[10rem] max-w-[220px] !whitespace-normal break-words text-slate-500">{e.note}</td>
                  {user.can("production.edit") && (
                    <td>
                      <ActionForm action={deleteEntry} confirm="Hapus entri ini? Mutasi stok & jurnal terkait akan dibalik.">
                        <input type="hidden" name="id" value={e.id} />
                        <Submit className="btn-secondary btn-sm" pendingText="…">Hapus</Submit>
                      </ActionForm>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-50 font-semibold"><td colSpan={5}>Total</td><td className="num">{totalGood}</td><td className="num text-rose-600">{totalReject}</td><td colSpan={2} /></tr>
            </tfoot>
          </table></Paged>
        </div>
      )}
    </div>
  );
}
