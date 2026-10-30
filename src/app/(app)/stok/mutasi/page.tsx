import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { MOVEMENT_LABEL } from "@/lib/stock";
import { idr } from "@/lib/money";
import { fmtDateTime, todayStr } from "@/lib/time";
import { Badge, Card, FilterBar, Field, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { createMovement } from "../actions";
import type { MovementType } from "@prisma/client";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Mutasi Stok" };

export default async function MutasiPage({ searchParams }: { searchParams: Promise<{ type?: string; item?: string }> }) {
  const user = await requirePerm("stock.move", "stock.view");
  const sp = await searchParams;
  const [items, locations, moves] = await Promise.all([
    prisma.item.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ orderBy: { code: "asc" } }),
    prisma.stockMovement.findMany({ where: { ...(sp.type ? { type: sp.type as MovementType } : {}), ...(sp.item ? { itemId: sp.item } : {}) }, include: { item: true, fromLocation: true, toLocation: true }, orderBy: { date: "desc" }, take: 200 }),
  ]);
  return (
    <div className="space-y-5">
      <PageHeader title="Mutasi stok" subtitle="Penerimaan, pengeluaran, transfer, penyesuaian, dan histori mutasi" actions={user.can("stock.move") && (
        <Modal trigger="+ Mutasi" title="Catat mutasi stok" wide>
          <ModalForm action={createMovement} className="grid grid-cols-2 gap-3">
            <Field label="Jenis"><select name="type" className="input"><option value="PENERIMAAN">Penerimaan</option><option value="PENGELUARAN">Pengeluaran</option><option value="TRANSFER">Transfer lokasi</option>{user.can("stock.approve") && <option value="PENYESUAIAN">Penyesuaian (opname)</option>}</select></Field>
            <Field label="Tanggal"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
            <Field label="Item" className="col-span-2"><select name="itemId" className="input" required>{items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}</select></Field>
            <Field label="Jumlah"><input name="qty" inputMode="decimal" className="input" required /></Field>
            <Field label="Dari lokasi" hint="Pengeluaran / transfer / penyesuaian"><select name="fromLocationId" className="input"><option value="">—</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
            <Field label="Ke lokasi" hint="Penerimaan / transfer"><select name="toLocationId" className="input"><option value="">—</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
            <Field label="Harga/unit (penerimaan)" hint="IDR, untuk harga rata-rata"><input name="unitCost" inputMode="numeric" className="input" /></Field>
            <Field label="Penyesuaian"><select name="direction" className="input"><option value="plus">Tambah (+)</option><option value="minus">Kurang (−)</option></select></Field>
            <Field label="No. referensi"><input name="ref" className="input" placeholder="No. nota / SJ" /></Field>
            <Field label="Catatan" className="col-span-2"><input name="note" className="input" /></Field>
            <p className="col-span-2 text-xs text-slate-500">Pembayaran pembelian bahan dicatat di Finance Inbox (kategori Pembelian Bahan Baku) agar tidak terjadi pembukuan ganda. Pengeluaran barang jadi otomatis membukukan HPP.</p>
            <div className="col-span-2 flex justify-end"><Submit>Simpan mutasi</Submit></div>
          </ModalForm>
        </Modal>
      )} />
      <FilterBar>
        <Field label="Jenis"><select name="type" defaultValue={sp.type ?? ""} className="input"><option value="">Semua</option>{Object.entries(MOVEMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Item"><select name="item" defaultValue={sp.item ?? ""} className="input"><option value="">Semua</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
      </FilterBar>
      <div className="table-wrap">
        <Paged><table className="tbl">
          <thead><tr><th>Waktu</th><th>Jenis</th><th>Item</th><th>Dari</th><th>Ke</th><th className="num">Qty</th><th className="num">Harga</th><th>Ref</th><th>Oleh</th></tr></thead>
          <tbody>
            {moves.map((m) => (
              <tr key={m.id}><td>{fmtDateTime(m.date)}</td><td><Badge tone={m.toLocationId && !m.fromLocationId ? "green" : !m.toLocationId ? "red" : "blue"}>{MOVEMENT_LABEL[m.type]}</Badge></td><td>{m.item.name}</td><td>{m.fromLocation?.code ?? "-"}</td><td>{m.toLocation?.code ?? "-"}</td><td className="num">{Number(m.qty).toLocaleString("id-ID")}</td><td className="num">{idr(m.unitCost)}</td><td className="text-xs">{m.ref}</td><td className="text-xs">{m.createdBy}</td></tr>
            ))}
          </tbody>
        </table></Paged>
      </div>
    </div>
  );
}
