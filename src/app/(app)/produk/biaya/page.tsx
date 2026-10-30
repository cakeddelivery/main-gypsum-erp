import { requirePerm } from "@/lib/auth";
import { feeConfig } from "@/lib/hpp";
import { CHANNEL_LABEL, feePct } from "@/lib/pricing";
import { idr } from "@/lib/money";
import { Card, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { ModalForm } from "@/components/ModalForm";
import { Modal } from "@/components/Modal";
import { ProdukTabs } from "../ProdukTabs";
import { saveFees } from "../actions";

export const metadata = { title: "Biaya Marketplace" };

export default async function BiayaPage() {
  const user = await requirePerm("product.view");
  const fees = await feeConfig();
  const channels = Object.keys(fees);
  return (
    <div className="space-y-5">
      <PageHeader title="Produk & HPP" subtitle="Potongan marketplace (persen dari harga) dan biaya pesanan flat per pesanan, dipakai untuk saran harga" actions={user.can("product.manage") && (
        <Modal trigger="Ubah Biaya" title="Biaya marketplace" wide>
          <ModalForm action={saveFees} className="space-y-4">
            {channels.map((ch) => (
              <div key={ch} className="rounded-xl border border-slate-200 p-3">
                <p className="mb-2 font-semibold">{CHANNEL_LABEL[ch] ?? ch}</p>
                {[...fees[ch].fees, { name: "", pct: 0 }].map((f, i) => (
                  <div key={i} className="mb-2 grid grid-cols-3 gap-2">
                    <input name={`fee_${ch}_name`} defaultValue={f.name} placeholder="Nama potongan" className="input col-span-2" />
                    <input name={`fee_${ch}_pct`} defaultValue={f.pct || ""} inputMode="decimal" placeholder="%" className="input" />
                  </div>
                ))}
                <label className="block"><span className="label">Biaya pesanan flat per pesanan (Rp)</span><input name={`perOrder_${ch}`} defaultValue={fees[ch].perOrder} inputMode="numeric" className="input" /></label>
              </div>
            ))}
            <p className="text-xs text-slate-500">Kosongkan nama atau persen untuk menghapus potongan.</p>
            <Submit>Simpan</Submit>
          </ModalForm>
        </Modal>
      )} />
      <ProdukTabs current="biaya" />
      <div className="grid gap-5 lg:grid-cols-2">
        {channels.map((ch) => (
          <Card key={ch} title={CHANNEL_LABEL[ch] ?? ch}>
            <ul className="divide-y divide-slate-100 text-sm">
              {fees[ch].fees.map((f) => <li key={f.name} className="flex justify-between py-1.5"><span>{f.name}</span><span className="tabular-nums">{f.pct.toLocaleString("id-ID")}%</span></li>)}
              <li className="flex justify-between py-1.5 font-semibold"><span>Total potongan</span><span>{feePct(fees[ch]).toLocaleString("id-ID")}%</span></li>
              <li className="flex justify-between py-1.5"><span>Biaya pesanan (per pesanan, bukan per produk)</span><span>{idr(fees[ch].perOrder)}</span></li>
            </ul>
          </Card>
        ))}
      </div>
      <p className="text-sm text-slate-500">Affiliate dan iklan diatur per produk (persen dari harga), begitu juga rata-rata jumlah produk per pesanan untuk membagi biaya pesanan.</p>
    </div>
  );
}
