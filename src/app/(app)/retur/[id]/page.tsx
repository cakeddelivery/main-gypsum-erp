import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { returnItemOptions } from "@/lib/returnScope";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, fmtDateTime, todayStr, dateStr } from "@/lib/time";
import { RETURN_STATUS, returnSetting, returnStatusOf } from "@/lib/returns";
import { marketplaceLabel } from "@/lib/returnLabel";
import { fmtBytes } from "@/lib/mediaStore";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ReturnFields } from "../ReturnFields";
import { VideoRecorder } from "../VideoRecorder";
import { VideoPlayer } from "../VideoPlayer";
import { cancelAction, claimAction, claimPaidAction, claimRejectedAction, editReturn, finishAction, inspectAction } from "../actions";

export const metadata = { title: "Detail Retur" };
const media = (id: string) => `/api/files/retur-media/${id}`;

export default async function ReturDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ rekam?: string }> }) {
  const user = await requirePerm("retur.manage");
  const { id } = await params;
  const sp = await searchParams;
  const r = await prisma.returnCase.findUnique({ where: { id }, include: { lines: { include: { item: { select: { name: true, unit: true } } }, orderBy: { sortOrder: "asc" } }, media: { orderBy: { createdAt: "asc" } } } });
  if (!r) notFound();
  const st = returnStatusOf(r);
  const open = !r.cancelledAt && r.status !== "SELESAI";
  const keepDays = await returnSetting("videoKeepDays");
  const [items, banks, claimTx] = await Promise.all([
    r.status === "DITERIMA" && open ? returnItemOptions(user) : [],
    r.status === "KLAIM_DIAJUKAN" ? prisma.bankAccount.findMany({ where: { active: true }, orderBy: [{ marketplace: "desc" }, { code: "asc" }] }) : [],
    r.claimJournalId ? prisma.financeTransaction.findFirst({ where: { journalId: r.claimJournalId }, select: { id: true, number: true } }) : null,
  ]);
  const videos = r.media.filter((m) => m.kind === "VIDEO");
  const thumb = r.media.find((m) => m.kind === "THUMB" && m.status === "READY");
  const frames = r.media.filter((m) => (m.kind === "FRAME" || m.kind === "THUMB") && m.status === "READY");
  const damage = r.media.filter((m) => m.kind === "DAMAGE" && m.status === "READY");
  const inspected = r.status !== "DITERIMA";
  const info: [string, React.ReactNode][] = [
    ["Diterima", fmtDate(r.receivedAt)], ["Marketplace", marketplaceLabel(r.marketplace)], ["Kurir", r.courier ?? "-"], ["No. resi", <span key="r" className="font-mono">{r.trackingNo}</span>],
    ["No. pesanan", r.orderNo ?? "-"], ["Tujuan", [r.city, r.province].filter(Boolean).join(", ") || "-"], ["Alasan", r.reason ?? "-"], ["Dicatat", `${r.createdBy} · ${fmtDateTime(r.createdAt)}`],
    ...(r.inspectedAt ? [["Diperiksa", `${r.inspectedBy} · ${fmtDateTime(r.inspectedAt)}`] as [string, string]] : []),
    ...(Number(r.shippingCost) ? [["Ongkir ditanggung", idr(Number(r.shippingCost))] as [string, string]] : []),
    ...(r.note ? [["Catatan", r.note] as [string, string]] : []),
    ...(r.cancelledAt ? [["Dibatalkan", `${fmtDateTime(r.cancelledAt)} — ${r.cancelReason}`] as [string, string]] : []),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Retur ${r.number}`}
        subtitle={<>{r.trackingNo} · {fmtDate(r.receivedAt)} · <Badge tone={st.tone}>{st.label}</Badge></>}
        actions={<>
          <Link href="/retur" className="btn-secondary">Kembali</Link>
          {open && r.status === "DITERIMA" && (
            <Modal trigger="Ubah data" title={`Ubah ${r.number}`} triggerClass="btn-secondary" full>
              <ModalForm action={editReturn}>
                <input type="hidden" name="id" value={r.id} />
                <ReturnFields items={items} today={todayStr()} defaults={{ date: dateStr(r.receivedAt), marketplace: r.marketplace, courier: r.courier, trackingNo: r.trackingNo, orderNo: r.orderNo, city: r.city, province: r.province, reason: r.reason, note: r.note, shippingCost: Number(r.shippingCost), lines: r.lines.map((l) => ({ labelSku: l.labelSku ?? "", labelVariation: l.labelVariation ?? "", labelName: l.labelName ?? "", qty: String(l.qty), itemId: l.itemId ?? "" })) }} />
                <div className="mt-4"><Submit>Simpan perubahan</Submit></div>
              </ModalForm>
            </Modal>
          )}
          {!r.cancelledAt && (
            <Modal trigger="Batalkan" title={`Batalkan ${r.number}`} triggerClass="btn-secondary">
              <ModalForm action={cancelAction} className="space-y-3">
                <input type="hidden" name="id" value={r.id} />
                <p className="text-sm">Untuk retur salah input. Jurnal hasil periksa & klaim dibalik, barang baik keluar lagi dari gudang. Data tetap tersimpan.</p>
                <Field label="Alasan"><input name="reason" className="input" required /></Field>
                <Submit className="btn-danger">Batalkan retur</Submit>
              </ModalForm>
            </Modal>
          )}
        </>}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Video unboxing">
          <div className="space-y-3">
            {videos.filter((v) => v.status !== "UPLOADING").map((v) => (
              <div key={v.id} className="space-y-1">
                {v.status === "READY" ? <VideoPlayer src={media(v.id)} poster={thumb ? media(thumb.id) : null} label={`${v.durationSec ? `${Math.floor(v.durationSec / 60)}:${String(v.durationSec % 60).padStart(2, "0")} · ` : ""}${fmtBytes(v.size)}`} />
                  : v.status === "PROCESSING" ? <p className="rounded-lg bg-slate-50 p-3 text-sm">⏳ Video sedang dikompres di server…</p>
                  : v.status === "DELETED" ? <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Video dihapus otomatis ({keepDays} hari setelah selesai). Potongan gambar tetap tersimpan.</p>
                  : <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">Video gagal: {v.error ?? "unggahan tidak selesai"}</p>}
                <p className="text-xs text-slate-500">Direkam {v.recordedAt ? fmtDateTime(v.recordedAt) : "-"} oleh {v.createdBy}{v.error && v.status === "READY" ? ` · ${v.error}` : ""}</p>
              </div>
            ))}
            {open ? <VideoRecorder returnId={r.id} number={r.number} trackingNo={r.trackingNo} autoStart={sp.rekam === "1" && !videos.length} /> : !videos.length && <p className="text-sm text-slate-500">Tidak ada video.</p>}
            {frames.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Potongan gambar (permanen)</p>
                <div className="grid grid-cols-4 gap-1.5">{frames.map((f) => <a key={f.id} href={media(f.id)} target="_blank" rel="noreferrer"><img src={media(f.id)} alt="" loading="lazy" className="aspect-video w-full rounded object-cover" /></a>)}</div>
              </div>
            )}
          </div>
        </Card>

        <Card title="Data paket">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {info.map(([k, v]) => <Fragment key={k}><dt className="text-slate-500">{k}</dt><dd className="[overflow-wrap:anywhere]">{v}</dd></Fragment>)}
          </dl>
          <p className="mt-3 text-xs text-slate-500">Data pribadi pembeli (nama, alamat, no. HP) tidak disimpan; foto label tidak disimpan.</p>
        </Card>
      </div>

      <Card title="Barang" actions={open && (r.status === "DITERIMA" || r.status === "DIPERIKSA") ? (
        <Modal trigger={inspected ? "Periksa ulang" : "Periksa barang"} title={`Periksa ${r.number}`} full>
          <ModalForm action={inspectAction} className="space-y-3">
            <input type="hidden" name="id" value={r.id} />
            <p className="text-sm text-slate-600">Isi jumlah <b>baik</b> (masuk lagi ke gudang barang jadi) dan <b>rusak</b> per barang. Sisanya dianggap tidak ada di paket. Rusak & tidak ada = kerugian (akun Kerugian Barang Retur Rusak).</p>
            {r.lines.map((l) => (
              <div key={l.id} className="rounded-lg border border-slate-200 p-3">
                <input type="hidden" name="lineId" value={l.id} />
                <p className="text-sm font-medium">{l.item?.name ?? <span className="text-rose-600">Belum dipetakan: {l.labelSku ?? l.labelName}</span>} <span className="text-slate-500">× {l.qty} di label</span></p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Field label="Baik"><input name="goodQty" type="number" min={0} max={l.qty} defaultValue={inspected ? l.goodQty : l.qty} className="input" required /></Field>
                  <Field label="Rusak"><input name="damagedQty" type="number" min={0} max={l.qty} defaultValue={inspected ? l.damagedQty : 0} className="input" required /></Field>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <Field label="Catatan kerusakan"><input name="lineNote" defaultValue={l.note ?? ""} className="input" placeholder="mis. pecah 2, cat luntur" /></Field>
                  <Field label="Foto rusak (opsional)"><input type="file" name={`damage:${l.id}`} accept="image/*" capture="environment" multiple className="block w-full min-w-0 max-w-full text-base" /></Field>
                </div>
              </div>
            ))}
            <Submit>Simpan hasil periksa</Submit>
          </ModalForm>
        </Modal>
      ) : undefined}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Label (SKU · variasi)</th><th>Produk ERP</th><th className="num">Qty</th><th className="num">Baik</th><th className="num">Rusak</th><th className="num">Tidak ada</th><th className="num">Harga pokok</th></tr></thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.id}>
                  <td className="text-xs"><span className="font-mono">{l.labelSku ?? "-"}</span>{l.labelVariation ? ` · ${l.labelVariation}` : ""}{l.labelName ? <div className="text-slate-500">{l.labelName}</div> : null}</td>
                  <td>{l.item?.name ?? <Badge tone="amber">belum dipetakan</Badge>}{l.note ? <div className="text-xs text-slate-500">{l.note}</div> : null}</td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{inspected ? l.goodQty : "-"}</td>
                  <td className="num">{inspected ? l.damagedQty : "-"}</td>
                  <td className="num">{inspected ? l.qty - l.goodQty - l.damagedQty : "-"}</td>
                  <td className="num">{inspected ? idr(Number(l.unitCost)) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {inspected && <p className="mt-2 text-sm">Kembali ke stok <b className="text-emerald-700">{idr(Number(r.goodValue))}</b> · Kerugian <b className="text-rose-700">{idr(Number(r.lossValue))}</b></p>}
        {damage.length > 0 && <div className="mt-3 grid grid-cols-4 gap-1.5 sm:grid-cols-6">{damage.map((f) => <a key={f.id} href={media(f.id)} target="_blank" rel="noreferrer"><img src={media(f.id)} alt="Foto kerusakan" loading="lazy" className="aspect-square w-full rounded object-cover" /></a>)}</div>}
      </Card>

      <Card title="Klaim & penyelesaian">
        <div className="space-y-2 text-sm">
          <p>Status: <Badge tone={st.tone}>{st.label}</Badge></p>
          {r.claimAt && <p>Klaim diajukan {fmtDate(r.claimAt)}: <b>{idr(Number(r.claimAmount))}</b>{r.claimNote ? ` — ${r.claimNote}` : ""}</p>}
          {r.claimPaidAt && <p>Klaim cair {fmtDate(r.claimPaidAt)}: <b className="text-emerald-700">{idr(Number(r.claimPaidAmount))}</b>{claimTx && <> · <Link href={`/finance/${claimTx.id}`} className="text-brand-600 underline">{claimTx.number}</Link></>}</p>}
          {r.claimRejectedAt && <p className="text-rose-700">Klaim ditolak {fmtDate(r.claimRejectedAt)}: {r.claimRejectReason}</p>}
          {r.doneAt && <p>Selesai {fmtDateTime(r.doneAt)} oleh {r.doneBy}. Video dihapus otomatis {keepDays} hari setelahnya.</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            {open && (r.status === "DIPERIKSA" || r.status === "KLAIM_DITOLAK") && (
              <Modal trigger="Ajukan klaim" title={`Klaim ${r.number}`} triggerClass="btn-secondary">
                <ModalForm action={claimAction} className="space-y-3">
                  <input type="hidden" name="id" value={r.id} />
                  <p className="text-sm">Klaim ke marketplace/kurir untuk barang rusak/hilang. Kerugian tercatat {idr(Number(r.lossValue))}.</p>
                  <Field label="Nominal klaim (Rp)"><input name="amount" inputMode="numeric" defaultValue={Number(r.lossValue) || ""} className="input" required /></Field>
                  <Field label="Catatan (no. tiket klaim, dll.)"><input name="note" className="input" /></Field>
                  <Submit>Ajukan klaim</Submit>
                </ModalForm>
              </Modal>
            )}
            {open && r.status === "KLAIM_DIAJUKAN" && (user.can("finance.create") ? (
              <Modal trigger="Klaim cair" title={`Klaim cair ${r.number}`}>
                <ModalForm action={claimPaidAction} className="space-y-3">
                  <input type="hidden" name="id" value={r.id} />
                  <p className="text-sm">Tercatat sebagai pemasukan kategori <b>Klaim Retur Marketplace</b> (tampil di menu Transaksi).</p>
                  <Field label="Tanggal cair"><input type="date" name="date" defaultValue={todayStr()} className="input" required /></Field>
                  <Field label="Nominal cair (Rp)"><input name="amount" inputMode="numeric" defaultValue={Number(r.claimAmount)} className="input" required /></Field>
                  <Field label="Masuk ke"><select name="bankAccountId" className="input" required>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                  <Field label="Bukti (opsional)"><input type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" className="block w-full min-w-0 max-w-full text-base" /></Field>
                  <Submit>Simpan klaim cair</Submit>
                </ModalForm>
              </Modal>
            ) : <span className="text-xs text-slate-500">Klaim cair dicatat oleh Finance / Admin Marketplace.</span>)}
            {open && r.status === "KLAIM_DIAJUKAN" && (
              <Modal trigger="Klaim ditolak" title={`Klaim ditolak ${r.number}`} triggerClass="btn-secondary">
                <ModalForm action={claimRejectedAction} className="space-y-3">
                  <input type="hidden" name="id" value={r.id} />
                  <Field label="Alasan ditolak"><input name="reason" className="input" required /></Field>
                  <Submit>Simpan</Submit>
                </ModalForm>
              </Modal>
            )}
            {open && ["DIPERIKSA", "KLAIM_CAIR", "KLAIM_DITOLAK"].includes(r.status) && (
              <Modal trigger="Tandai selesai" title={`Selesaikan ${r.number}`} triggerClass="btn-secondary">
                <ModalForm action={finishAction} className="space-y-3">
                  <input type="hidden" name="id" value={r.id} />
                  <p className="text-sm">Retur selesai. Video akan dihapus otomatis {keepDays} hari lagi untuk menghemat ruang; thumbnail, potongan gambar & data retur tetap tersimpan.</p>
                  <Submit>Selesai</Submit>
                </ModalForm>
              </Modal>
            )}
          </div>
          <p className="text-xs text-slate-500">Alur: {Object.values(RETURN_STATUS).map((s) => s.label).join(" → ")}</p>
        </div>
      </Card>
    </div>
  );
}
