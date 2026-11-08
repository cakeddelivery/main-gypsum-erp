import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { locationSettings, stockBalances } from "@/lib/stock";
import { idr } from "@/lib/money";
import { fmtDateTime, todayStr } from "@/lib/time";
import { Card, Empty, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
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
      <PageHeader title="Opname barang jadi" subtitle="Tiap akhir bulan: hitung fisik produk jadi di gudang. Yang berkurang dari stok sistem = terjual, dicatat sebagai HPP di laba rugi." />
      {!finished ? <Empty title="Lokasi gudang barang jadi belum diatur" hint="Atur di Pengaturan › Parameter" /> : items.length === 0 ? <Empty title="Belum ada produk jadi di master data" /> : (
        <Card title="Hitung fisik">
          <ActionForm action={opnameFinished} className="space-y-3">
            <Field label="Tanggal opname" hint="Biasanya tanggal terakhir bulan"><input type="date" name="date" defaultValue={todayStr()} className="input max-w-xs" /></Field>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>Produk</th><th className="num">Stok sistem</th><th className="num">HPP/unit</th><th>Jumlah fisik</th></tr></thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>{i.name}</td>
                      <td className="num">{sys(i.id).toLocaleString("id-ID")} {i.unit}</td>
                      <td className="num">{idr(i.avgCost)}</td>
                      <td><input name={`fisik_${i.id}`} inputMode="decimal" className="input w-28" placeholder="kosong = lewati" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500">Isi hanya produk yang dihitung. Stok fisik lebih sedikit dari sistem → selisih × HPP/unit dicatat Dr HPP / Cr Persediaan Barang Jadi. Lebih banyak → stok ditambah (Beban Selisih Persediaan berkurang).</p>
            <div className="flex justify-end"><Submit>Simpan opname</Submit></div>
          </ActionForm>
        </Card>
      )}
      {recent.length > 0 && (
        <Card title="Riwayat opname">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Waktu</th><th>Produk</th><th className="num">Selisih</th><th className="num">Nilai</th></tr></thead>
              <tbody>{recent.map((m) => { const minus = !!m.fromLocationId; return <tr key={m.id}><td>{fmtDateTime(m.date)}</td><td>{m.item.name}</td><td className={`num ${minus ? "text-rose-600" : "text-emerald-600"}`}>{minus ? "−" : "+"}{Number(m.qty).toLocaleString("id-ID")}</td><td className="num">{idr(Math.round(Number(m.qty) * Number(m.unitCost)))}</td></tr>; })}</tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
