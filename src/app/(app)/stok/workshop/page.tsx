import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { workshopHistory, workshopItems, workshopPlan } from "@/lib/produksiWorkshop";
import { prisma } from "@/lib/db";
import { fmtDateTime, todayStr } from "@/lib/time";
import { Card, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { cancelWorkshopAction, saveWorkshop } from "./actions";

export const metadata = { title: "Produksi Workshop" };
const fmt = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 3 });

export default async function WorkshopPage({ searchParams }: { searchParams: Promise<{ item?: string; qty?: string; mode?: string }> }) {
  const user = await requirePerm("stock.produce");
  const sp = await searchParams;
  const ras = sp.mode === "ras";
  const items = await workshopItems();
  const allItems = ras ? await prisma.item.findMany({ where: { active: true, type: { in: ["BAHAN_BAKU", "BARANG_DALAM_PROSES"] } }, orderBy: { name: "asc" }, select: { id: true, name: true, unit: true } }) : [];
  const qty = Number((sp.qty ?? "").replace(",", "."));
  const plan = sp.item && qty > 0 ? await workshopPlan(prisma, sp.item, qty).catch(() => null) : null;
  const history = await workshopHistory();
  return (
    <div className="space-y-5">
      <PageHeader title={ras ? "Rakit ulang" : "Produksi workshop"} subtitle={ras ? "Rakit ulang produk dari komponen layak (hasil bongkar retur) + pengganti dari stok; tanpa upah borongan" : "Setengah jadi buatan karyawan di workshop (mis. Cat Plastik, Cat Giftbox): bahan otomatis dari resep, tanpa upah borongan"} actions={<><Link href={ras ? "/stok/workshop" : "/stok/workshop?mode=ras"} className="btn-secondary">{ras ? "Produksi workshop" : "Rakit ulang"}</Link><Link href="/stok" className="btn-secondary">Stok</Link></>} />
      <Card title="1. Pilih hasil & jumlah">
        <form method="get" className="grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
          {ras && <input type="hidden" name="mode" value="ras" />}
          <Field label={ras ? "Produk yang dirakit" : "Hasil produksi"}><select name="item" defaultValue={sp.item ?? ""} className="input h-12 text-base" required><option value="">— pilih —</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}</select></Field>
          <Field label="Jumlah"><input name="qty" inputMode="decimal" defaultValue={sp.qty ?? ""} className="input h-12 text-base" required /></Field>
          <button className="btn-primary h-12 text-base">Lihat bahan ▶</button>
        </form>
        {!items.length && <p className="mt-2 text-sm text-slate-500">Belum ada barang dengan resep bahan. Isi resep di Produk & HPP (atau jalankan setup:produk-hpp).</p>}
      </Card>
      {plan && (
        <Card title={`2. Bahan untuk ${fmt(plan.qty)} ${plan.output.unit} ${plan.output.name}`}>
          <ActionForm action={saveWorkshop} className="space-y-3">
            <input type="hidden" name="itemId" value={plan.output.id} />
            <input type="hidden" name="kind" value={ras ? "RAS" : "WSP"} />
            <input type="hidden" name="qty" value={plan.qty} />
            <div className="space-y-2">
              {plan.lines.map((l) => (
                <label key={l.itemId} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2">
                  <span className="min-w-0 text-sm"><b>{l.name}</b><span className="block text-xs text-slate-500">resep {fmt(l.planned)} {l.unit} · stok {fmt(l.available)} {l.unit}{l.available < l.planned ? " ⚠ kurang" : ""}</span></span>
                  <span className="flex shrink-0 items-center gap-1"><input name={`a.${l.itemId}`} inputMode="decimal" defaultValue={l.planned} className="input w-24 text-right" aria-label={`Aktual ${l.name}`} /><span className="text-xs text-slate-500">{l.unit}</span></span>
                </label>
              ))}
            </div>
            {ras && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Komponen pengganti dari stok (opsional)</p>
                {[0, 1, 2].map((k) => (
                  <div key={k} className="grid grid-cols-[1fr_6rem] gap-2"><select name="x.item" className="input" defaultValue=""><option value="">— pilih komponen —</option>{allItems.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}</select><input name="x.qty" inputMode="decimal" placeholder="Qty" className="input text-right" /></div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tanggal"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
              <Field label="Catatan"><input name="note" className="input" /></Field>
            </div>
            <p className="text-xs text-slate-500">Bahan terpakai dikurangi dari stok (harga rata-rata ikut); hasil masuk setengah jadi bernilai bahan + overhead resep. Tanpa upah borongan.</p>
            <Submit>{ras ? "Simpan rakit ulang" : "Simpan produksi"}</Submit>
          </ActionForm>
        </Card>
      )}
      <Card title="Riwayat">
        <div className="table-wrap"><table className="tbl"><thead><tr><th>Nomor</th><th>Jenis</th><th>Waktu</th><th>Hasil</th><th className="num">Qty</th><th className="num">Nilai/unit</th><th>Oleh</th><th /></tr></thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.number} className={h.cancelled ? "text-slate-400 line-through" : ""}>
                <td className="font-mono text-xs">{h.number}</td><td>{h.kind === "RAS" ? "Rakit ulang" : "Produksi"}</td><td>{fmtDateTime(h.date)}</td><td>{h.item}</td><td className="num">{fmt(h.qty)} {h.unit}</td><td className="num">Rp {h.unitCost.toLocaleString("id-ID")}</td><td>{h.by}</td>
                <td>{!h.cancelled && user.can("stock.approve") && (
                  <ActionForm action={cancelWorkshopAction} className="flex gap-1"><input type="hidden" name="number" value={h.number} /><input name="reason" placeholder="Alasan batal" className="input w-32 py-1 text-xs" required /><Submit className="btn-danger btn-sm" confirm="Batalkan produksi ini? Stok & jurnal dibalik.">Batal</Submit></ActionForm>
                )}</td>
              </tr>
            ))}
            {!history.length && <tr><td colSpan={8} className="text-center text-slate-500">Belum ada produksi workshop</td></tr>}
          </tbody></table></div>
      </Card>
    </div>
  );
}
