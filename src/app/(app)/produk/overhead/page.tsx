import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { overheadSummary, overheadUnitCost } from "@/lib/hpp";
import { fmtUnitPrice } from "@/lib/unitcost";
import { OverheadForm, type OverheadData } from "./OverheadForm";
import { idr } from "@/lib/money";
import { Badge, Card, Empty, Field, PageHeader, Stat } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ProdukTabs } from "../ProdukTabs";
import { deleteOverhead, saveCapacity } from "../actions";
import type { Overhead } from "@prisma/client";

export const metadata = { title: "Overhead" };

const data = (o: Overhead): OverheadData => ({ id: o.id, name: o.name, category: o.category, monthlyAmount: Number(o.monthlyAmount), outputPerMonth: o.outputPerMonth, assetCost: o.assetCost ? Number(o.assetCost) : null, lifeMonths: o.lifeMonths, note: o.note, active: o.active });

export default async function OverheadPage() {
  const user = await requirePerm("product.view");
  const manage = user.can("product.manage");
  const [rows, sum] = await Promise.all([prisma.overhead.findMany({ orderBy: [{ active: "desc" }, { category: "asc" }, { name: "asc" }] }), overheadSummary()]);
  return (
    <div className="space-y-5">
      <PageHeader title="Produk & HPP" subtitle="Beban per pcs = biaya per bulan ÷ estimasi output per bulan. Pilih overhead ini di resep setengah jadi atau produk jadi." actions={manage && <Modal trigger="+ Overhead" title="Tambah Overhead Produksi"><OverheadForm capacity={sum.capacity} /></Modal>} />
      <ProdukTabs current="overhead" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Total overhead / bulan" value={idr(sum.total)} />
        <Stat label="Output default / bulan" value={sum.capacity ? `${sum.capacity.toLocaleString("id-ID")} pcs` : "belum diisi"} hint={manage && (
          <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Output default per bulan">
            <ModalForm action={saveCapacity} className="space-y-3">
              <Field label="Rata-rata pcs diproduksi per bulan" hint="Dipakai bila output overhead dikosongkan"><input name="capacity" inputMode="numeric" defaultValue={sum.capacity || ""} className="input" required /></Field>
              <Submit>Simpan</Submit>
            </ModalForm>
          </Modal>
        )} />
        <Stat label="Total beban per pcs" value={idr(sum.perPcs)} tone="blue" hint="Bila semua overhead dipakai faktor 1" />
      </div>
      <Card title="Daftar overhead">
        {rows.length === 0 ? <Empty title="Belum ada overhead" hint="Tambahkan listrik, LPG, bensin, air, penyusutan, sewa, wifi, perlengkapan produksi." /> : (
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>Kategori</th><th>Nama</th><th className="num">Per bulan</th><th className="num">Output / bulan</th><th className="num">Beban / pcs</th><th>Keterangan</th><th /></tr></thead>
            <tbody>{rows.map((o) => (
              <tr key={o.id} className={o.active ? "" : "opacity-50"}>
                <td>{o.category}</td><td>{o.name}{!o.active && <Badge>nonaktif</Badge>}</td><td className="num">{idr(o.monthlyAmount)}</td>
                <td className="num">{o.outputPerMonth ? `${o.outputPerMonth.toLocaleString("id-ID")} pcs` : <span className="text-slate-400">{sum.capacity ? `${sum.capacity.toLocaleString("id-ID")} (default)` : "-"}</span>}</td>
                <td className="num">{fmtUnitPrice(overheadUnitCost(o, sum.capacity))}</td>
                <td className="text-xs">{[o.assetCost && o.lifeMonths ? `${idr(o.assetCost)} ÷ ${o.lifeMonths} bulan` : "", o.note].filter(Boolean).join(" · ")}</td>
                <td>{manage && <span className="flex gap-2">
                  <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah ${o.name}`}><OverheadForm o={data(o)} capacity={sum.capacity} /></Modal>
                  <ActionForm action={deleteOverhead} confirm={`Hapus ${o.name}?`}><input type="hidden" name="id" value={o.id} /><Submit className="btn-secondary btn-sm" pendingText="…">Hapus</Submit></ActionForm>
                </span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
