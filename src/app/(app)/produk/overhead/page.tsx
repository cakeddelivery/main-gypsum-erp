import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { overheadSummary } from "@/lib/hpp";
import { OVERHEAD_CATEGORIES } from "@/lib/pricing";
import { idr } from "@/lib/money";
import { Badge, Card, Empty, Field, PageHeader, Stat } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ProdukTabs } from "../ProdukTabs";
import { deleteOverhead, saveCapacity, saveOverhead } from "../actions";
import type { Overhead } from "@prisma/client";

export const metadata = { title: "Overhead" };

function OverheadForm({ o }: { o?: Overhead }) {
  return (
    <ModalForm action={saveOverhead} className="space-y-3">
      {o && <input type="hidden" name="id" value={o.id} />}
      <Field label="Kategori"><select name="category" defaultValue={o?.category ?? ""} className="input" required><option value="" disabled>— pilih kategori —</option>{OVERHEAD_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
      <Field label="Nama" hint="Boleh kosong, otomatis sama dengan kategori"><input name="name" defaultValue={o?.name ?? ""} className="input" placeholder="cth: Oven Besar" /></Field>
      <Field label="Biaya per bulan (Rp)"><input name="monthlyAmount" inputMode="numeric" defaultValue={o ? Number(o.monthlyAmount) : ""} className="input" /></Field>
      <div className="rounded-xl border border-slate-200 p-3">
        <p className="text-xs text-slate-500">Untuk penyusutan oven/cetakan: isi harga aset dan umur pakainya, biaya per bulan dihitung otomatis.</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Field label="Harga aset (Rp)"><input name="assetCost" inputMode="numeric" defaultValue={o?.assetCost ? Number(o.assetCost) : ""} className="input" /></Field>
          <Field label="Umur (bulan)"><input name="lifeMonths" inputMode="numeric" defaultValue={o?.lifeMonths ?? ""} className="input" /></Field>
        </div>
      </div>
      {o && <Field label="Status"><select name="active" defaultValue={o.active ? "on" : "off"} className="input"><option value="on">Aktif</option><option value="off">Nonaktif</option></select></Field>}
      <Submit>Simpan</Submit>
    </ModalForm>
  );
}

export default async function OverheadPage() {
  const user = await requirePerm("product.view");
  const manage = user.can("product.manage");
  const [rows, sum] = await Promise.all([prisma.overhead.findMany({ orderBy: [{ active: "desc" }, { category: "asc" }, { name: "asc" }] }), overheadSummary()]);
  return (
    <div className="space-y-5">
      <PageHeader title="Produk & HPP" subtitle="Biaya overhead bulanan dibagi kapasitas produksi per bulan = overhead per pcs" actions={manage && <Modal trigger="+ Overhead" title="Overhead baru"><OverheadForm /></Modal>} />
      <ProdukTabs current="overhead" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Total overhead / bulan" value={idr(sum.total)} />
        <Stat label="Kapasitas produksi / bulan" value={sum.capacity ? `${sum.capacity.toLocaleString("id-ID")} pcs` : "belum diisi"} hint={manage && (
          <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Kapasitas produksi per bulan">
            <ModalForm action={saveCapacity} className="space-y-3">
              <Field label="Rata-rata pcs diproduksi per bulan"><input name="capacity" inputMode="numeric" defaultValue={sum.capacity || ""} className="input" required /></Field>
              <Submit>Simpan</Submit>
            </ModalForm>
          </Modal>
        )} />
        <Stat label="Overhead per pcs" value={idr(sum.perPcs)} tone="blue" hint="Pakai di resep setengah jadi atau produk jadi" />
      </div>
      <Card title="Daftar overhead">
        {rows.length === 0 ? <Empty title="Belum ada overhead" hint="Tambahkan listrik, LPG, bensin, air, penyusutan, sewa, wifi, perlengkapan produksi." /> : (
          <table className="tbl">
            <thead><tr><th>Kategori</th><th>Nama</th><th className="num">Per bulan</th><th>Keterangan</th><th /></tr></thead>
            <tbody>{rows.map((o) => (
              <tr key={o.id} className={o.active ? "" : "opacity-50"}>
                <td>{o.category}</td><td>{o.name}{!o.active && <Badge>nonaktif</Badge>}</td><td className="num">{idr(o.monthlyAmount)}</td>
                <td className="text-xs">{o.assetCost && o.lifeMonths ? `${idr(o.assetCost)} ÷ ${o.lifeMonths} bulan` : ""}</td>
                <td>{manage && <span className="flex gap-2">
                  <Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title={`Ubah ${o.name}`}><OverheadForm o={o} /></Modal>
                  <ActionForm action={deleteOverhead} confirm={`Hapus ${o.name}?`}><input type="hidden" name="id" value={o.id} /><Submit className="btn-secondary btn-sm" pendingText="…">Hapus</Submit></ActionForm>
                </span>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
