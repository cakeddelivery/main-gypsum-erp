import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { MOVEMENT_LABEL } from "@/lib/stock";
import { idr } from "@/lib/money";
import { fmtDateTime, jakartaDateTime, todayStr } from "@/lib/time";
import { Empty, FilterBar, Field, PageHeader } from "@/components/ui";
import { DownloadJpg } from "@/components/DownloadJpg";
import { DocExport, DocBar, DocSheet, DocSummary, DocTable, fmtLong, fmtRange } from "@/components/DocSheet";
import { letterhead } from "@/lib/letterhead";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Kartu Persediaan" };

export default async function KartuPage({ searchParams }: { searchParams: Promise<{ item?: string; from?: string; to?: string }> }) {
  await requirePerm("stock.view", "accounting.view");
  const sp = await searchParams;
  const items = await prisma.item.findMany({ orderBy: { name: "asc" } });
  const item = items.find((i) => i.id === sp.item) ?? items[0];
  if (!item) return <Empty />;
  const from = sp.from ? jakartaDateTime(sp.from, "00:00") : null;
  const to = sp.to ? new Date(jakartaDateTime(sp.to, "00:00").getTime() + 86400000) : null;
  const all = await prisma.stockMovement.findMany({ where: { itemId: item.id, ...(to ? { date: { lt: to } } : {}) }, include: { fromLocation: true, toLocation: true }, orderBy: [{ date: "asc" }, { id: "asc" }] });
  const sign = (m: (typeof all)[number]) => (m.toLocationId && !m.fromLocationId ? 1 : !m.toLocationId && m.fromLocationId ? -1 : 0);
  let bal = 0;
  let opening = 0;
  const rows: { m: (typeof all)[number]; inQ: number; outQ: number; bal: number }[] = [];
  for (const m of all) {
    const q = Number(m.qty) * sign(m);
    bal += q;
    if (from && m.date < from) { opening = bal; continue; }
    rows.push({ m, inQ: q > 0 ? q : 0, outQ: q < 0 ? -q : 0, bal });
  }
  const lh = await letterhead();
  return (
    <div>
      <PageHeader title="Kartu persediaan" subtitle={item.name} actions={<DownloadJpg targetId="kartu" filename={`kartu-${item.sku}`} />} />
      <FilterBar>
        <Field label="Item"><select name="item" defaultValue={item.id} className="input">{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
        <Field label="Dari"><input type="date" name="from" defaultValue={sp.from} className="input" /></Field>
        <Field label="Sampai"><input type="date" name="to" defaultValue={sp.to} className="input" /></Field>
      </FilterBar>
      <div className="table-wrap bg-white">
        <Paged><table className="tbl">
          <thead><tr><th>Tanggal</th><th>Jenis</th><th>Lokasi</th><th>Ref</th><th className="num">Masuk</th><th className="num">Keluar</th><th className="num">Saldo</th><th className="num">Harga</th><th className="num">Nilai saldo</th></tr></thead>
          <tbody>
            <tr className="bg-slate-50"><td colSpan={6}>Saldo awal</td><td className="num font-semibold">{opening.toLocaleString("id-ID")}</td><td /><td /></tr>
            {rows.map(({ m, inQ, outQ, bal }) => (
              <tr key={m.id}><td>{fmtDateTime(m.date)}</td><td>{MOVEMENT_LABEL[m.type]}</td><td className="text-xs">{m.fromLocation?.code ?? ""}{m.fromLocation && m.toLocation && " → "}{m.toLocation?.code ?? ""}</td><td className="text-xs">{m.ref}</td><td className="num text-emerald-600">{inQ ? inQ.toLocaleString("id-ID") : ""}</td><td className="num text-rose-600">{outQ ? outQ.toLocaleString("id-ID") : ""}</td><td className="num font-semibold">{bal.toLocaleString("id-ID")}</td><td className="num">{idr(m.unitCost)}</td><td className="num">{idr(Math.round(bal * Number(m.unitCost)))}</td></tr>
            ))}
          </tbody>
        </table></Paged>
      </div>
      <DocExport>
        <DocSheet
          id="kartu" lh={lh} eyebrow="Laporan persediaan" title="Kartu Persediaan" subtitle={item.name}
          meta={{ label: "Periode", value: sp.from ? fmtRange(sp.from, sp.to || todayStr()) : `s.d. ${fmtLong(sp.to || todayStr())}` }}
          notes={[`Satuan stok: ${item.unit}. Harga = harga per unit pada saat mutasi.`, "Laporan ini dihasilkan secara otomatis dari sistem dan dapat digunakan sebagai referensi internal."]}
        >
          <DocBar label="Saldo awal" value={`${opening.toLocaleString("id-ID")} ${item.unit}`} />
          <DocTable head={<tr><th>Tanggal</th><th>Jenis</th><th>Lokasi</th><th>Ref</th><th className="num">Masuk</th><th className="num">Keluar</th><th className="num">Saldo</th><th className="num">Harga (Rp)</th><th className="num">Nilai saldo (Rp)</th></tr>} empty={rows.length ? undefined : "Tidak ada mutasi pada periode ini"}>
            {rows.map(({ m, inQ, outQ, bal }) => (
              <tr key={m.id}><td className="whitespace-nowrap">{fmtDateTime(m.date)}</td><td>{MOVEMENT_LABEL[m.type]}</td><td className="whitespace-nowrap text-xs">{m.fromLocation?.code ?? ""}{m.fromLocation && m.toLocation && " → "}{m.toLocation?.code ?? ""}</td><td className="text-xs">{m.ref}</td><td className="num doc-pos">{inQ ? inQ.toLocaleString("id-ID") : "-"}</td><td className="num doc-neg">{outQ ? outQ.toLocaleString("id-ID") : "-"}</td><td className="num font-semibold">{bal.toLocaleString("id-ID")}</td><td className="num">{Number(m.unitCost).toLocaleString("id-ID")}</td><td className="num">{Math.round(bal * Number(m.unitCost)).toLocaleString("id-ID")}</td></tr>
            ))}
          </DocTable>
          <DocSummary rows={[{ label: "Saldo akhir", hint: `Nilai persediaan ${idr(Math.round(bal * Number(rows.at(-1)?.m.unitCost ?? item.avgCost)))}`, value: `${bal.toLocaleString("id-ID")} ${item.unit}`, strong: true }]} />
        </DocSheet>
      </DocExport>
    </div>
  );
}
