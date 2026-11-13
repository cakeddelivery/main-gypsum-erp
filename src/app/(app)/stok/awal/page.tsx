import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { locationSettings, stockBalances } from "@/lib/stock";
import { idr } from "@/lib/money";
import { fmtDateTime, todayStr } from "@/lib/time";
import { VARIANTS } from "@/lib/shiftReport";
import { flowEnabled, flowItem } from "@/lib/shiftReportFlow";
import { OPENING_SETTING } from "@/lib/stockOpening";
import { Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Paged } from "@/components/Paged";
import { saveOpening } from "../actions";

export const metadata = { title: "Stok Awal" };

/**
 * Stok awal riil: hitung fisik semua bahan baku (per divisi), patung kering, produk jadi per karakter, giftbox.
 * Dilakukan sekali sebelum sakelar "Hasil kerja → stok" dinyalakan, agar nilai stok sebagai aset riil.
 */
export default async function StokAwalPage() {
  await requirePerm("stock.approve");
  const locs = await locationSettings(prisma);
  // Barang patung kering & produk jadi per karakter disiapkan dulu (kode tetap) agar bisa dihitung
  await prisma.$transaction(async (tx) => {
    for (const v of VARIANTS) {
      await flowItem(tx, { kind: "kering", key: v });
      await flowItem(tx, { kind: "jadi", key: v });
    }
  });
  const [items, balances, divisions, flowOn, last] = await Promise.all([
    prisma.item.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    stockBalances(),
    prisma.division.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    flowEnabled(),
    prisma.setting.findUnique({ where: { key: OPENING_SETTING } }),
  ]);
  const locOf = (t: string) => (t === "BAHAN_BAKU" ? locs.raw : t === "BARANG_DALAM_PROSES" ? locs.wip : locs.finished);
  const sys = (i: { id: string; type: string }) => balances.find((b) => b.itemId === i.id && b.locationId === locOf(i.type))?.qty ?? 0;
  const groups = [
    ...divisions.map((d) => ({ key: d.id, title: `Bahan baku · ${d.name}`, rows: items.filter((i) => i.type === "BAHAN_BAKU" && i.divisionId === d.id) })),
    { key: "bb-lain", title: "Bahan baku lain (tanpa divisi)", rows: items.filter((i) => i.type === "BAHAN_BAKU" && !i.divisionId) },
    { key: "bdp", title: "Barang setengah jadi (patung kering per karakter, dll.)", rows: items.filter((i) => i.type === "BARANG_DALAM_PROSES") },
    { key: "bj", title: "Produk jadi per karakter & giftbox", rows: items.filter((i) => i.type === "BARANG_JADI") },
  ].filter((g) => g.rows.length);
  const fmt = (n: number) => Number(n.toFixed(3)).toLocaleString("id-ID");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Stok awal riil"
        subtitle="Hitung fisik semua barang sekali, supaya nilai stok sebagai aset terlihat riil. Setelah itu nyalakan sakelar Hasil kerja → stok."
        actions={locs.raw && locs.wip && locs.finished && groups.length > 0 && (
          <Modal full trigger="+ Hitung stok awal" title="Hitung stok awal riil" subtitle="Kosongkan barang yang tidak dihitung">
            <ModalForm action={saveOpening} className="space-y-4">
              <div className="keep-cols grid grid-cols-2 gap-3">
                <Field label="Tanggal hitung"><input type="date" name="date" defaultValue={todayStr()} className="input" required /></Field>
                <Field label="Jam (WIB)"><input type="time" name="time" defaultValue="06:00" className="input" required /></Field>
              </div>
              {groups.map((g, gi) => (
                <details key={g.key} open={gi === 0} className="group rounded-xl border border-slate-200">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-semibold text-slate-700 [&::-webkit-details-marker]:hidden">
                    <span>{g.title} <span className="font-normal text-slate-500">({g.rows.length})</span></span>
                    <span className="text-xs text-slate-500 transition group-open:rotate-180" aria-hidden>▾</span>
                  </summary>
                  <ul className="divide-y divide-slate-100 border-t border-slate-100">
                    {g.rows.map((i) => (
                      <li key={i.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <div className="min-w-0 basis-full sm:flex-1 sm:basis-40">
                          <div className="text-sm">{i.name}</div>
                          <div className="text-xs text-slate-500">Sistem {fmt(sys(i))} {i.unit} · <span className={Number(i.avgCost) === 0 ? "text-amber-600" : ""}>{idr(i.avgCost)}</span></div>
                        </div>
                        <input name={`fisik_${i.id}`} inputMode="decimal" aria-label={`Jumlah fisik ${i.name}`} className="input min-w-0 flex-1 text-right sm:w-24 sm:flex-none" placeholder="Jumlah fisik" />
                        <input name={`harga_${i.id}`} inputMode="numeric" aria-label={`Harga per satuan ${i.name}`} className="input min-w-0 flex-1 text-right sm:w-28 sm:flex-none" placeholder={Number(i.avgCost) ? "Harga tetap" : "Rp/satuan"} />
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
              <div className="modal-foot">
                <Submit className="btn-primary flex-1" confirm="Simpan stok awal? Stok sistem di gudang akan disamakan dengan hitungan fisik.">Simpan stok awal</Submit>
              </div>
            </ModalForm>
          </Modal>
        )}
      />
      <Card title="Langkah">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
          <li>Pilih waktu hitung (sebaiknya setelah semua shift selesai, mis. malam / pagi sebelum produksi). Jangan ada produksi saat menghitung.</li>
          <li>Pastikan semua <b>barang masuk</b> sudah dicatat dan kiriman borongan yang sudah sampai sudah ditekan <b>Terima</b>.</li>
          <li>Hitung fisik di gudang: semua bahan baku tiap divisi, patung kering per karakter, produk jadi per karakter, giftbox. Barang di titik borongan (BMR/Mastrip/Beringin) tidak ikut — stoknya dari serah terima.</li>
          <li>Tekan <b>+ Hitung stok awal</b>, isi kolom <b>Jumlah fisik</b>. Kosongkan barang yang tidak dihitung. Isi <b>Harga/satuan</b> bila harga rata-rata masih Rp0 atau salah (pakai harga beli terakhir).</li>
          <li>Tekan <b>Simpan stok awal</b>. Selisih nilai masuk ke Ekuitas Saldo Awal (tidak mengubah laba rugi).</li>
          <li>Buka <Link className="link" href="/laporan/bahan">Laporan Shift › Bahan & checklist</Link>, lalu nyalakan sakelar <b>Hasil kerja → stok</b>. Status sekarang: {flowOn ? <Badge tone="green">menyala</Badge> : <Badge tone="amber">mati</Badge>}</li>
        </ol>
        {last && <p className="mt-2 text-xs text-slate-500">Stok awal terakhir disimpan: {fmtDateTime(new Date(last.value))}</p>}
      </Card>
      {!locs.raw || !locs.wip || !locs.finished ? <Empty title="Lokasi gudang belum diatur" hint="Atur di Pengaturan › Parameter" /> : (
        groups.map((g) => (
          <Card key={g.key} title={g.title}>
            <div className="table-wrap border-0">
              <Paged>
                <table className="tbl">
                  <thead><tr><th>Barang</th><th className="num">Stok sistem</th><th className="num">Harga rata²</th></tr></thead>
                  <tbody>
                    {g.rows.map((i) => (
                      <tr key={i.id}>
                        <td>{i.name}<div className="text-xs text-slate-400">{i.sku}</div></td>
                        <td className="num">{fmt(sys(i))} {i.unit}</td>
                        <td className={`num ${Number(i.avgCost) === 0 ? "text-amber-600" : ""}`}>{idr(i.avgCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Paged>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
