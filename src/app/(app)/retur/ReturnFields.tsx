"use client";
import { useRef, useState } from "react";
import { classifyCodes, COURIERS, MARKETPLACES, PROVINCES, type LabelRead } from "@/lib/returnLabel";
import { readLabelAction } from "./actions";

type Opt = { id: string; name: string };
type Row = { k: number; labelSku: string; labelVariation: string; labelName: string; qty: string; itemId: string };
export type ReturnDefaults = Partial<Omit<LabelRead, "lines">> & { date?: string; reason?: string | null; note?: string | null; shippingCost?: number; lines?: Omit<Row, "k">[] };

export const RETURN_REASONS = ["Pembeli mengembalikan barang", "Gagal kirim / tidak diterima", "Pesanan dibatalkan", "Salah kirim", "Lainnya"];

/** Kecilkan foto di HP sebelum dikirim (lebih cepat di sinyal lemah); foto tidak disimpan di server */
export async function shrink(file: File, max = 1600): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b ?? file), "image/jpeg", 0.85));
  } catch {
    return file;
  }
}

/** Baca semua barcode di foto: BarcodeDetector bawaan HP (Android/Chrome), cadangan ZXing (iPhone/Safari) */
export async function detectCodes(file: File): Promise<string[]> {
  const out = new Set<string>();
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return [];
  const W = window as unknown as { BarcodeDetector?: { new (o?: { formats: string[] }): { detect(s: CanvasImageSource): Promise<{ rawValue: string }[]> }; getSupportedFormats?: () => Promise<string[]> } };
  if (W.BarcodeDetector) {
    try {
      const sup = (await W.BarcodeDetector.getSupportedFormats?.()) ?? [];
      const formats = ["code_128", "code_39", "code_93", "codabar", "ean_13", "itf", "qr_code", "pdf417", "data_matrix"].filter((f) => !sup.length || sup.includes(f));
      for (const r of await new W.BarcodeDetector({ formats }).detect(bmp)) out.add(r.rawValue);
    } catch {
      /* lanjut ZXing */
    }
  }
  if (!out.size) {
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const reader = new BrowserMultiFormatReader();
      // Label punya beberapa barcode: coba gambar utuh, bagian atas, dan bagian bawah
      const parts: [number, number][] = [[0, 1], [0, 0.55], [0.45, 1]];
      for (const [a, b] of parts) {
        const c = document.createElement("canvas");
        const s = Math.min(1, 1800 / bmp.width);
        c.width = Math.round(bmp.width * s);
        c.height = Math.round(bmp.height * (b - a) * s);
        c.getContext("2d")!.drawImage(bmp, 0, bmp.height * a, bmp.width, bmp.height * (b - a), 0, 0, c.width, c.height);
        try {
          out.add(reader.decodeFromCanvas(c).getText());
        } catch {
          /* tidak ada barcode di bagian ini */
        }
      }
    } catch {
      /* ZXing gagal dimuat */
    }
  }
  return [...out];
}

/**
 * Isian retur: foto label → barcode dibaca di HP (no. resi akurat) → foto dikirim ke server untuk dibaca AI/OCR
 * (marketplace, kurir, no. pesanan, kota/kab, provinsi, produk) → hasil ditampilkan untuk dikonfirmasi.
 * Foto label tidak disimpan. Nama, alamat, dan no. HP pembeli tidak diambil.
 */
export function ReturnFields({ items, today, defaults }: { items: Opt[]; today: string; defaults?: ReturnDefaults }) {
  const [v, setV] = useState<ReturnDefaults>(defaults ?? {});
  const [ver, setVer] = useState(0);
  const [rows, setRows] = useState<Row[]>((defaults?.lines?.length ? defaults.lines : [{ labelSku: "", labelVariation: "", labelName: "", qty: "1", itemId: "" }]).map((l, i) => ({ ...l, k: i })));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [labelRead, setLabelRead] = useState<{ source: string; codes: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (i: number, patch: Partial<Row>) => setRows((x) => x.map((y, j) => (j === i ? { ...y, ...patch } : y)));

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setMsg(null);
    setBusy("Membaca barcode…");
    const codes = await detectCodes(file);
    const g = classifyCodes(codes);
    const next: ReturnDefaults = { ...v, trackingNo: g.trackingNo ?? v.trackingNo, orderNo: g.orderNo ?? v.orderNo, courier: g.courier ?? v.courier, marketplace: g.marketplace ?? v.marketplace };
    setV(next);
    setVer((n) => n + 1);
    setBusy("Membaca isi label (AI/OCR)…");
    const fd = new FormData();
    fd.set("label", new File([await shrink(file)], "label.jpg", { type: "image/jpeg" }));
    const r = await readLabelAction(fd).catch(() => ({ ok: false, error: "Server tidak terjangkau" }) as Awaited<ReturnType<typeof readLabelAction>>);
    setBusy(null);
    if (fileRef.current) fileRef.current.value = "";
    if (!r.ok || !r.read) {
      setLabelRead({ source: "MANUAL", codes });
      setMsg({ tone: "warn", text: `${g.trackingNo ? `No. resi terbaca dari barcode. ` : ""}Isi label lain belum terbaca (${r.error ?? "gagal"}). Lengkapi manual.` });
      return;
    }
    const x = r.read;
    // Barcode lebih akurat untuk resi & no. pesanan; sisanya dari AI/OCR
    setV({ ...next, trackingNo: g.trackingNo ?? x.trackingNo ?? next.trackingNo, orderNo: g.orderNo ?? x.orderNo ?? next.orderNo, courier: g.courier ?? x.courier ?? next.courier, marketplace: g.marketplace ?? x.marketplace ?? next.marketplace, city: x.city ?? next.city, province: x.province ?? next.province });
    if (x.lines.length) setRows(x.lines.map((l, i) => ({ k: Date.now() + i, labelSku: l.sku ?? "", labelVariation: l.variation ?? "", labelName: l.name ?? "", qty: String(l.qty), itemId: r.matches?.[i] ?? "" })));
    setVer((n) => n + 1);
    setLabelRead({ source: r.source ?? "MANUAL", codes });
    const unmapped = x.lines.filter((_, i) => !r.matches?.[i]).length;
    setMsg({
      tone: r.error || unmapped || !x.trackingNo && !g.trackingNo ? "warn" : "ok",
      text: `Terbaca dengan ${r.source === "AI" ? "AI" : "OCR"}${codes.length ? " + barcode" : ""}. Periksa lagi semua isian${unmapped ? `; ${unmapped} barang belum dipetakan ke produk ERP, pilih manual` : ""}.${r.error ? ` (${r.error})` : ""}`,
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-dashed border-brand-300 bg-brand-50/50 p-3">
        <p className="text-sm font-medium">1. Foto label resi</p>
        <p className="mt-0.5 text-xs text-slate-600">Foto hanya dibaca lalu dibuang (tidak disimpan). Nama, alamat & no. HP pembeli tidak diambil.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className={`btn-primary btn-sm cursor-pointer ${busy ? "pointer-events-none opacity-60" : ""}`}>
            📷 {labelRead ? "Foto ulang label" : "Foto label resi"}
            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => onPhoto(e.target.files?.[0])} />
          </label>
          {busy && <span className="text-xs text-slate-600">⏳ {busy}</span>}
        </div>
        {msg && <p className={`mt-2 rounded-lg px-2 py-1.5 text-xs ${msg.tone === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{msg.text}</p>}
        <input type="hidden" name="labelRead" value={labelRead ? JSON.stringify(labelRead) : ""} />
      </div>

      <div key={ver} className="grid gap-3 sm:grid-cols-2">
        <label><span className="label">No. resi *</span><input name="trackingNo" defaultValue={v.trackingNo ?? ""} className="input font-mono uppercase" required minLength={6} placeholder="Scan dari foto label atau ketik" /></label>
        <label><span className="label">Tanggal paket diterima</span><input type="date" name="date" defaultValue={v.date ?? today} max={today} className="input" required /></label>
        <label><span className="label">Marketplace</span><select name="marketplace" defaultValue={v.marketplace ?? ""} className="input"><option value="">—</option>{MARKETPLACES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></label>
        <label><span className="label">Kurir</span><select name="courier" defaultValue={v.courier ?? ""} className="input"><option value="">—</option>{[...new Set([...(v.courier && !COURIERS.includes(v.courier) ? [v.courier] : []), ...COURIERS])].map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <label><span className="label">No. pesanan</span><input name="orderNo" defaultValue={v.orderNo ?? ""} className="input font-mono uppercase" /></label>
        <label><span className="label">Alasan retur</span><select name="reason" defaultValue={v.reason ?? RETURN_REASONS[0]} className="input">{RETURN_REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
        <label><span className="label">Kota / Kabupaten tujuan</span><input name="city" defaultValue={v.city ?? ""} className="input" placeholder="mis. Kab. Lamongan" /></label>
        <label><span className="label">Provinsi</span><select name="province" defaultValue={v.province ?? ""} className="input"><option value="">—</option>{PROVINCES.map((p) => <option key={p}>{p}</option>)}</select></label>
      </div>

      <div className="space-y-2 rounded-xl border border-slate-200 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Barang di dalam paket (sesuai label)</p>
        {rows.map((r, i) => (
          <div key={r.k} className="grid grid-cols-12 items-start gap-2 border-b border-slate-100 pb-2 last:border-0 [&>*]:min-w-0">
            <label className="col-span-6 sm:col-span-3"><span className="sr-only">SKU</span><input name="labelSku" value={r.labelSku} onChange={(e) => set(i, { labelSku: e.target.value })} className="input font-mono uppercase" placeholder="SKU label" /></label>
            <label className="col-span-6 sm:col-span-3"><span className="sr-only">Variasi</span><input name="labelVariation" value={r.labelVariation} onChange={(e) => set(i, { labelVariation: e.target.value })} className="input uppercase" placeholder="Variasi" /></label>
            <label className="col-span-3 sm:col-span-1"><span className="sr-only">Jumlah</span><input name="qty" inputMode="numeric" value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} className="input" required placeholder="Qty" /></label>
            <div className="col-span-8 sm:col-span-4">
              <select name="itemId" value={r.itemId} onChange={(e) => set(i, { itemId: e.target.value })} className="input">
                <option value="">— produk ERP (pilih) —</option>
                {items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              {r.labelName && <p className="mt-1 truncate text-xs text-slate-500">Label: {r.labelName}</p>}
              <input type="hidden" name="labelName" value={r.labelName} />
            </div>
            <button type="button" aria-label="Hapus baris" className="btn-secondary btn-sm btn-icon col-span-1" onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : x))}>×</button>
          </div>
        ))}
        <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((x) => [...x, { k: Date.now(), labelSku: "", labelVariation: "", labelName: "", qty: "1", itemId: "" }])}>+ Tambah barang</button>
        <p className="text-xs text-slate-500">Produk ERP yang dipilih diingat untuk SKU + variasi yang sama di retur berikutnya.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label><span className="label">Ongkir retur ditanggung toko (Rp, opsional)</span><input name="shippingCost" inputMode="numeric" defaultValue={v.shippingCost || ""} className="input" placeholder="0" /><span className="mt-1 block text-xs text-slate-500">Untuk analitik kerugian; tidak dibukukan di sini</span></label>
        <label><span className="label">Catatan</span><textarea name="note" defaultValue={v.note ?? ""} rows={2} className="input" /></label>
      </div>
    </div>
  );
}
