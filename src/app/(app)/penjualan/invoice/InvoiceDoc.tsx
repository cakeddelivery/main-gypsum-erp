import type { Invoice } from "@prisma/client";
import { DocBar, DocSection, DocSheet, DocTable, fmtLong } from "@/components/DocSheet";
import type { Letterhead } from "@/lib/letterhead";
import { CHANNELS, invoiceStatus, isChannel, type InvoiceLine } from "@/lib/invoice";
import { idr } from "@/lib/money";
import { dateStr } from "@/lib/time";

/** Invoice ber-kop (tema terang): dipakai halaman detail (JPG) dan halaman cetak (PDF). Cap LUNAS bila lunas. */
export function InvoiceDoc({ inv, lh, salePaid, storeName, id = "invoice" }: { inv: Invoice; lh: Letterhead; salePaid?: bigint | null; storeName: string; id?: string }) {
  const st = invoiceStatus(inv, salePaid);
  const lines = inv.lines as unknown as InvoiceLine[];
  const channel = isChannel(inv.channel) ? CHANNELS[inv.channel].label : inv.channel;
  const paid = salePaid ?? inv.paid;
  return (
    <DocSheet
      id={id}
      lh={lh}
      eyebrow={`Invoice · ${storeName}`}
      title={inv.number}
      subtitle={<>Kepada: <b>{inv.customerName}</b> · {channel}</>}
      meta={{ label: "Tanggal", value: fmtLong(dateStr(inv.date)) }}
      notes={[...(inv.note ? [inv.note] : []), "Harga mengikuti channel penjualan produk.", ...(inv.cancelledAt ? [`Invoice ini dibatalkan${inv.cancelReason ? `: ${inv.cancelReason}` : ""}.`] : [])]}
      signer={storeName}
      signDate={dateStr(inv.date)}
    >
      <div style={{ position: "relative" }}>
        {st.lunas && <div style={{ position: "absolute", right: 8, top: -6, border: "3px solid #17784f", color: "#17784f", fontWeight: 800, padding: "2px 14px", borderRadius: 6, transform: "rotate(-8deg)", letterSpacing: ".12em", fontSize: 22, opacity: 0.85 }}>LUNAS</div>}
        {inv.cancelledAt && <div style={{ position: "absolute", right: 8, top: -6, border: "3px solid #b0243a", color: "#b0243a", fontWeight: 800, padding: "2px 14px", borderRadius: 6, transform: "rotate(-8deg)", letterSpacing: ".12em", fontSize: 22, opacity: 0.85 }}>BATAL</div>}
        <DocSection title="Rincian" hint={`${lines.length} barang`}>
          <DocTable head={<tr><th>Barang</th><th className="num">Jumlah</th><th className="num">Harga</th><th className="num">Total</th></tr>}>
            {lines.map((l, i) => (
              <tr key={i}><td>{l.name}</td><td className="num">{l.qty.toLocaleString("id-ID")} {l.unit}</td><td className="num">{idr(l.price)}</td><td className="num">{idr(l.amount)}</td></tr>
            ))}
          </DocTable>
        </DocSection>
        <DocBar label="Jumlah harga" value={idr(inv.subtotal)} />
        {inv.discount > BigInt(0) && <DocBar label="Diskon" value={`−${idr(inv.discount)}`} tone="amber" negative />}
        {inv.shipping > BigInt(0) && <DocBar label="Ongkos kirim" value={idr(inv.shipping)} />}
        <DocBar label="Total tagihan" value={idr(inv.total)} tone="green" />
        {paid > BigInt(0) && <DocBar label="Sudah dibayar" note={st.lunas ? "Lunas" : `Sisa ${idr(inv.total - paid)}`} value={idr(paid)} />}
      </div>
    </DocSheet>
  );
}
