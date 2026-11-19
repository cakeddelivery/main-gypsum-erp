import { DocSheet, DocSection, fmtLong } from "@/components/DocSheet";
import type { Letterhead } from "@/lib/letterhead";
import { idr } from "@/lib/money";
import { fmtDate } from "@/lib/time";
import { marketplaceLabel } from "@/lib/returnLabel";
import { returnStatusOf } from "@/lib/returns";
import type { Prisma } from "@prisma/client";

export type ReturnClaimData = Prisma.ReturnCaseGetPayload<{ include: { lines: { include: { item: { select: { name: true } }; pieces: { include: { item: { select: { name: true } } } } } } } }>;
const short = (n: string) => n.replace(/^single pack\s*/i, "") || n;

/** Lembar klaim marketplace/kurir ber-kop surat (JPG & PDF): data paket, rincian per barang & per pcs, nilai klaim */
export function ReturnClaimSheet({ r, lh, id }: { r: ReturnClaimData; lh: Letterhead; id: string }) {
  const st = returnStatusOf(r);
  const loss = Number(r.lossValue);
  return (
    <DocSheet
      id={id}
      lh={lh}
      eyebrow="Klaim retur marketplace"
      title={`${r.number} · ${r.trackingNo}`}
      subtitle={`${marketplaceLabel(r.marketplace)}${r.courier ? ` · ${r.courier}` : ""} · diterima ${fmtDate(r.receivedAt)} · status ${st.label}`}
      meta={{ label: "Nilai klaim / kerugian", value: idr(Number(r.claimAmount) || loss) }}
      notes={["Kerugian = (isi paket − pcs baik) × harga pokok per pcs. Pcs baik kembali ke stok.", ...(r.orderNo ? [`No. pesanan: ${r.orderNo}`] : []), ...(r.reason ? [`Alasan retur: ${r.reason}`] : [])]}
      signer="Supervisor / Finance"
      signDate={fmtLong(r.claimAt ?? r.receivedAt)}
    >
      <DocSection title="Rincian barang">
        <div className="doc-table"><table>
          <thead><tr><th>Barang</th><th>Karakter</th><th>Isi</th><th>Baik</th><th>Rusak</th><th>Tidak ada</th><th>HPP/pcs</th><th>Kerugian</th></tr></thead>
          <tbody>
            {r.lines.map((l) => {
              if (l.pieceMode && l.pieces.length) {
                return l.pieces.map((p, i) => {
                  const cap = p.perPack * l.qty;
                  return (
                    <tr key={p.id}>
                      <td>{i === 0 ? `${l.item?.name ?? l.labelSku} × ${l.qty} paket` : ""}</td>
                      <td>{short(p.item.name)}</td>
                      <td>{cap}</td><td>{p.goodQty}</td><td>{p.damagedQty}</td><td>{cap - p.goodQty - p.damagedQty}</td>
                      <td>{idr(Number(p.unitCost))}</td><td>{idr((cap - p.goodQty) * Number(p.unitCost))}</td>
                    </tr>
                  );
                });
              }
              return (
                <tr key={l.id}>
                  <td>{l.item?.name ?? l.labelSku ?? "-"}</td><td>-</td><td>{l.qty}</td><td>{l.goodQty}</td><td>{l.damagedQty}</td><td>{l.qty - l.goodQty - l.damagedQty}</td>
                  <td>{idr(Number(l.unitCost))}</td><td>{idr((l.qty - l.goodQty) * Number(l.unitCost))}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </DocSection>
      <DocSection title="Ringkasan">
        <p>Kembali ke stok: <b>{idr(Number(r.goodValue))}</b> · Kerugian: <b>{idr(loss)}</b>{Number(r.shippingCost) ? ` · Ongkir ditanggung: ${idr(Number(r.shippingCost))}` : ""}</p>
        {r.claimAt && <p>Klaim diajukan {fmtDate(r.claimAt)}: <b>{idr(Number(r.claimAmount))}</b>{r.claimNote ? ` — ${r.claimNote}` : ""}</p>}
        {r.claimPaidAt && <p>Klaim cair {fmtDate(r.claimPaidAt)}: <b>{idr(Number(r.claimPaidAmount))}</b></p>}
      </DocSection>
    </DocSheet>
  );
}

export const returnClaimInclude = { lines: { include: { item: { select: { name: true } }, pieces: { include: { item: { select: { name: true } } } } }, orderBy: { sortOrder: "asc" } } } as const;
