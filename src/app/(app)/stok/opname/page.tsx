import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { locationSettings, stockBalances } from "@/lib/stock";
import { idr } from "@/lib/money";
import { fmtDateTime, todayStr } from "@/lib/time";
import { Card, Empty, Field, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Paged } from "@/components/Paged";
import { opnameFinished } from "../actions";

export const metadata = { title: "Opname Barang Jadi" };

/** Hitung fisik produk jadi akhir bulan: yang berkurang dari stok sistem dicatat sebagai barang terjual (HPP) */
export default async function OpnamePage() {
  await requirePerm("stock.approve");
  const { finished } = await locationSettings(prisma);
  const [items, balances, recent] = await Promise.all([
    prisma.item.findMany({ where: { type: "BARANG_JADI", active: true }, orderBy: { name: "asc" } }),
    stockBalances(),
    prisma.stockMovement.findMany({ where: { ref: { startsWith: "OPN-" } }, include: { item: true }, orderBy: { date: "desc" }, take: 30 }),
  ]);
  const sys = (id: string) => balances.find((b) => b.itemId === id && b.locationId === finished)?.qty ?? 0;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Opname barang jadi"
        subtitle="Tiap akhir bulan: hitung fisik produk jadi di gudang. Yang berkurang dari stok sistem = terjual, dicatat sebagai HPP di laba rugi."
        actions={finished && items.length > 0 && (
          <Modal trigger="+ Opname" title="Hitung fisik barang jadi" wide>
            <ModalForm action={opnameFinished} className="space-y-3">
              <Field label="Tanggal opname" hint="Biasanya tanggal terakhir bulan"><input type="date" name="date" defaultValue={todayStr()} className="input max-w-xs" required /></Field>
              <p className="text-xs text-slate-500">Isi hanya produk yang dihitung (kosong = lewati).</p>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {items.map((i) => (
                  <li key={i.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">{i.name}</div>
                      <div className="text-xs text-slate-500">Sistem {sys(i.id).toLocaleString("id-ID")} {i.unit} · HPP {idr(i.avgCost)}</div>
                    </div>
                    <input name={`fisik_${i.id}`} inputMode="decimal" aria-label={`Jumlah fisik ${i.name}`} className="input w-28 shrink-0 text-right" placeholder="fisik" />
                  </li>
                ))}
              </ul>
              <p className="text-xs text-slate-500">Stok fisik lebih sedikit dari sistem → selisih × HPP/unit dicatat Dr HPP / Cr Persediaan Barang Jadi. Lebih banyak → stok ditambah (Beban Selisih Persediaan berkurang).</p>
              <Submit>Simpan opname</Submit>
            </ModalForm>
          </Modal>
        )}
      />
      {!finished ? <Empty title="Lokasi gudang barang jadi belum diatur" hint="Atur di Pengaturan › Parameter" /> : items.length === 0 ? <Empty title="Belum ada produk jadi di master data" /> : (
        <Card title="Stok barang jadi (sistem)">
          <div className="table-wrap border-0">
            <Paged>
              <table className="tbl">
                <thead><tr><th>Produk</th><th className="num">Stok sistem</th><th className="num">HPP/unit</th></tr></thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}><td>{i.name}</td><td className="num">{sys(i.id).toLocaleString("id-ID")} {i.unit}</td><td className="num">{idr(i.avgCost)}</td></tr>
                  ))}
                </tbody>
              </table>
            </Paged>
          </div>
        </Card>
      )}
      {recent.length > 0 && (
        <Card title="Riwayat opname">
          <div className="table-wrap border-0">
            <Paged>
              <table className="tbl">
                <thead><tr><th>Waktu</th><th>Produk</th><th className="num">Selisih</th><th className="num">Nilai</th></tr></thead>
                <tbody>{recent.map((m) => { const minus = !!m.fromLocationId; return <tr key={m.id}><td>{fmtDateTime(m.date)}</td><td>{m.item.name}</td><td className={`num ${minus ? "text-rose-600" : "text-emerald-600"}`}>{minus ? "−" : "+"}{Number(m.qty).toLocaleString("id-ID")}</td><td className="num">{idr(Math.round(Number(m.qty) * Number(m.unitCost)))}</td></tr>; })}</tbody>
              </table>
            </Paged>
          </div>
        </Card>
      )}
    </div>
  );
}
