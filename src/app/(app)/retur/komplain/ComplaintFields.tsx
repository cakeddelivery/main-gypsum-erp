"use client";
import { useRef, useState } from "react";
import { classifyCodes, COURIERS, MARKETPLACES, PROVINCES } from "@/lib/returnLabel";
import { ISSUE_TYPES } from "@/lib/complaintShared";
import { BankSelect } from "@/components/BankSelect";
import { readLabelAction } from "../actions";
import { detectCodes, shrink } from "../ReturnFields";
import { OrderLookup } from "../OrderLookup";
import type { OrderHit } from "@/lib/marketplace/lookup";

type Opt = { id: string; name: string; stock?: number };
type Row = { k: number; labelSku: string; labelName: string; itemId: string; qty: string; sendQty: string };
type Head = { trackingNo?: string | null; orderNo?: string | null; marketplace?: string | null; courier?: string | null; city?: string | null; province?: string | null };

/**
 * Form komplain: foto label (opsional, sama seperti retur) → jenis masalah → barang & jumlah bermasalah → bukti dari
 * pembeli → solusi Refund (nominal + rekening/e-wallet pembeli) atau Kirim ganti (jumlah pengganti, bisa dibarengkan).
 */
export function ComplaintFields({ items, today, prefill }: { items: Opt[]; today: string; prefill?: OrderHit | null }) {
  const [v, setV] = useState<Head>({});
  const [ver, setVer] = useState(0);
  const [rows, setRows] = useState<Row[]>([{ k: 0, labelSku: "", labelName: "", itemId: "", qty: "1", sendQty: "1" }]);
  const [solution, setSolution] = useState("REFUND");
  const [amount, setAmount] = useState("");
  const [autoQ, setAutoQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [labelRead, setLabelRead] = useState<{ source: string; codes: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (i: number, p: Partial<Row>) => setRows((x) => x.map((y, j) => (j === i ? { ...y, ...p } : y)));

  /** Isi form dari pesanan marketplace; ubah qty menjadi jumlah yang BERMASALAH saja */
  function fromOrder(h: OrderHit) {
    setV((o) => ({ ...o, trackingNo: h.trackingNo ?? o.trackingNo, orderNo: h.orderNo, marketplace: h.marketplace, courier: h.courier ?? o.courier, city: h.city ?? o.city, province: h.province ?? o.province }));
    const ls = h.lines.filter((l) => !l.extra);
    if (ls.length) setRows(ls.map((l, i) => ({ k: Date.now() + i, labelSku: l.sku ?? "", labelName: [l.variation, l.name].filter(Boolean).join(" · "), itemId: l.itemId && items.some((x) => x.id === l.itemId) ? l.itemId : "", qty: String(l.qty), sendQty: String(l.qty) })));
    setVer((n) => n + 1);
    setMsg("Terisi dari pesanan marketplace. Ubah jumlah barang menjadi jumlah yang BERMASALAH saja.");
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setBusy("Membaca barcode…");
    const codes = await detectCodes(file);
    const g = classifyCodes(codes);
    setBusy("Membaca isi label…");
    const fd = new FormData();
    fd.set("label", new File([await shrink(file)], "label.jpg", { type: "image/jpeg" }));
    const r = await readLabelAction(fd).catch(() => ({ ok: false, error: "Server tidak terjangkau" }) as Awaited<ReturnType<typeof readLabelAction>>);
    setBusy(null);
    if (fileRef.current) fileRef.current.value = "";
    const x = r.read;
    setV((o) => ({ ...o, trackingNo: g.trackingNo ?? x?.trackingNo ?? o.trackingNo, orderNo: g.orderNo ?? x?.orderNo ?? o.orderNo, marketplace: g.marketplace ?? x?.marketplace ?? o.marketplace, courier: g.courier ?? x?.courier ?? o.courier, city: x?.city ?? o.city, province: x?.province ?? o.province }));
    if (x?.lines.length) setRows(x.lines.map((l, i) => ({ k: Date.now() + i, labelSku: l.sku ?? "", labelName: [l.variation, l.name].filter(Boolean).join(" · "), itemId: r.matches?.[i] ?? "", qty: String(l.qty), sendQty: String(l.qty) })));
    setVer((n) => n + 1);
    setAutoQ([g.trackingNo ?? x?.trackingNo, g.orderNo ?? x?.orderNo].filter(Boolean).join(" "));
    setLabelRead({ source: r.ok ? r.source ?? "MANUAL" : "MANUAL", codes });
    setMsg(r.ok ? "Label terbaca. Ubah jumlah barang menjadi jumlah yang BERMASALAH saja." : `Label belum terbaca (${r.error ?? "gagal"}); isi manual.`);
  }

  return (
    <div className="space-y-4">
      <OrderLookup kind="KOMPLAIN" onPick={fromOrder} prefill={prefill} autoQuery={autoQ} />
      <div className="rounded-xl border border-dashed border-brand-300 bg-brand-50/50 p-3">
        <p className="text-sm font-medium">Foto label resi (opsional)</p>
        <p className="mt-0.5 text-xs text-slate-600">Atau ketik no. resi / no. pesanan di bawah. Foto tidak disimpan.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className={`btn-secondary btn-sm cursor-pointer ${busy ? "pointer-events-none opacity-60" : ""}`}>📷 Foto label<input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => onPhoto(e.target.files?.[0])} /></label>
          {busy && <span className="text-xs text-slate-600">⏳ {busy}</span>}
        </div>
        {msg && <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-800">{msg}</p>}
        <input type="hidden" name="labelRead" value={labelRead ? JSON.stringify(labelRead) : ""} />
      </div>

      <div key={ver} className="grid gap-3 sm:grid-cols-2">
        <label><span className="label">No. resi</span><input name="trackingNo" defaultValue={v.trackingNo ?? ""} className="input font-mono uppercase" /></label>
        <label><span className="label">No. pesanan</span><input name="orderNo" defaultValue={v.orderNo ?? ""} className="input font-mono uppercase" /></label>
        <label><span className="label">Tanggal komplain</span><input type="date" name="date" defaultValue={today} max={today} className="input" required /></label>
        <label><span className="label">Marketplace</span><select name="marketplace" defaultValue={v.marketplace ?? ""} className="input"><option value="">—</option>{MARKETPLACES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></label>
        <label><span className="label">Kurir</span><select name="courier" defaultValue={v.courier ?? ""} className="input"><option value="">—</option>{[...new Set([...(v.courier && !COURIERS.includes(v.courier) ? [v.courier] : []), ...COURIERS])].map((c) => <option key={c}>{c}</option>)}</select></label>
        <label><span className="label">Kota / Kabupaten</span><input name="city" defaultValue={v.city ?? ""} className="input" /></label>
        <label><span className="label">Provinsi</span><select name="province" defaultValue={v.province ?? ""} className="input"><option value="">—</option>{PROVINCES.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label><span className="label">Jenis masalah *</span><select name="issueType" defaultValue="PECAH" className="input" required>{ISSUE_TYPES.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select></label>
      </div>
      <label className="block"><span className="label">Keterangan dari pembeli</span><textarea name="description" rows={2} className="input" placeholder="mis. 4 pcs pecah saat diterima" /></label>

      <div className="space-y-2 rounded-xl border border-slate-200 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Barang bermasalah</p>
        {rows.map((r, i) => (
          <div key={r.k} className="grid grid-cols-12 items-start gap-2 border-b border-slate-100 pb-2 last:border-0 [&>*]:min-w-0">
            <div className="col-span-12 sm:col-span-6">
              <select name="itemId" value={r.itemId} onChange={(e) => set(i, { itemId: e.target.value })} className="input" required>
                <option value="">— produk ERP —</option>
                {items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              {(r.labelSku || r.labelName) && <p className="mt-1 break-words text-xs text-slate-500">Label: {[r.labelSku, r.labelName].filter(Boolean).join(" · ")}</p>}
              <input type="hidden" name="labelSku" value={r.labelSku} /><input type="hidden" name="labelName" value={r.labelName} />
            </div>
            <label className="col-span-5 sm:col-span-2"><span className="text-xs text-slate-500">Qty bermasalah</span><input name="qty" inputMode="numeric" value={r.qty} onChange={(e) => set(i, { qty: e.target.value, sendQty: e.target.value })} className="input" required /></label>
            <label className={`col-span-5 sm:col-span-3 ${solution === "KIRIM_GANTI" ? "" : "invisible"}`}><span className="text-xs text-slate-500">Qty pengganti</span><input name="sendQty" inputMode="numeric" value={r.sendQty} onChange={(e) => set(i, { sendQty: e.target.value })} className="input" /></label>
            <button type="button" aria-label="Hapus baris" className="btn-secondary btn-sm btn-icon col-span-2 mt-5 sm:col-span-1" onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : x))}>×</button>
          </div>
        ))}
        <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((x) => [...x, { k: Date.now(), labelSku: "", labelName: "", itemId: "", qty: "1", sendQty: "1" }])}>+ Tambah barang</button>
      </div>

      <label className="block"><span className="label">Ongkir ditanggung toko (Rp, opsional)</span><input name="shippingCost" inputMode="numeric" className="input" placeholder="0" /><span className="mt-1 block text-xs text-slate-500">Mis. ongkir kirim ganti. Untuk analitik kerugian; bila dibayar dari rekening tetap catat di Transaksi</span></label>
      <label className="block"><span className="label">Bukti dari pembeli (foto / video chat, boleh lebih dari satu, total maks 15 MB)</span>
        <input type="file" name="evidence" accept="image/*,video/*" multiple className="block w-full min-w-0 max-w-full text-base" />
      </label>

      <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
        <label className="block"><span className="label">Solusi *</span>
          <select name="solution" value={solution} onChange={(e) => setSolution(e.target.value)} className="input"><option value="REFUND">Refund (uang kembali)</option><option value="KIRIM_GANTI">Kirim ganti</option></select>
        </label>
        {solution === "REFUND" ? (
          <>
            <label className="block"><span className="label">Nominal refund (Rp) *</span><input name="refundAmount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" required placeholder="mis. 50% dari harga barang bermasalah" /></label>
            <div className="grid gap-3 sm:grid-cols-3">
              <div><span className="label">Bank / e-wallet *</span><BankSelect name="payeeBank" required /></div>
              <label><span className="label">No. rekening / HP *</span><input name="payeeAccount" inputMode="numeric" className="input font-mono" required autoComplete="off" /></label>
              <label><span className="label">Atas nama *</span><input name="payeeName" className="input" required autoComplete="off" /></label>
            </div>
            <p className="text-xs text-slate-600">🔒 Rekening pembeli hanya terlihat oleh Anda, Finance, dan Owner.</p>
          </>
        ) : (
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="bundleNext" className="mt-1" /> <span>Barengkan dengan pesanan berikutnya pembeli<span className="block text-xs text-slate-500">Stok baru keluar saat ditandai «Pengganti dikirim».</span></span></label>
        )}
      </div>
    </div>
  );
}
