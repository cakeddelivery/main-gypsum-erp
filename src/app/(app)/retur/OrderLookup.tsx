"use client";
import { useEffect, useRef, useState } from "react";
import type { OrderHit } from "@/lib/marketplace/lookup";
import { classifyCodes } from "@/lib/returnLabel";
import { findOrderAction } from "./actions";
import { detectCodes } from "./ReturnFields";

const idr = (v: number) => `Rp ${v.toLocaleString("id-ID")}`;

/**
 * Cari pesanan marketplace berdasarkan No. Pesanan / No. Resi: ketik, scanner USB (mengetik + Enter), atau Scan kamera
 * (barcode/QR langsung, atau foto label). Memilih hasil mengisi form otomatis lewat onPick. Tanpa data pribadi pembeli.
 */
export function OrderLookup({ kind, onPick, prefill, autoQuery }: { kind: "RETUR" | "KOMPLAIN"; onPick: (h: OrderHit) => void; prefill?: OrderHit | null; /** Hasil baca label (AI/OCR/barcode) dicocokkan otomatis ke pesanan */ autoQuery?: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<OrderHit[] | null>(null);
  const [picked, setPicked] = useState<OrderHit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stop = useRef<(() => void) | null>(null);
  const photo = useRef<HTMLInputElement>(null);

  const choose = (h: OrderHit) => {
    setPicked(h);
    setHits(null);
    onPick(h);
  };
  useEffect(() => {
    if (prefill) choose(prefill);
    return () => stop.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (autoQuery && autoQuery.trim().length >= 6) {
      setQ(autoQuery.split(" ")[0]);
      void search(autoQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoQuery]);

  async function search(text: string) {
    const t = text.trim();
    if (t.length < 6) return;
    setBusy(true);
    setError(null);
    const r = await findOrderAction(t).catch(() => ({ ok: false, error: "Server tidak terjangkau" }) as Awaited<ReturnType<typeof findOrderAction>>);
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "Gagal mencari");
    if (!r.hits?.length) {
      setHits([]);
      return;
    }
    if (r.hits.length === 1) choose(r.hits[0]);
    else setHits(r.hits);
  }

  async function startScan() {
    setError(null);
    setScanning(true);
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const reader = new BrowserMultiFormatReader();
      const controls = await reader.decodeFromVideoDevice(undefined, video.current!, (result) => {
        if (!result) return;
        const text = result.getText();
        controls.stop();
        stop.current = null;
        setScanning(false);
        setQ(text.slice(0, 120));
        void search(text);
      });
      stop.current = () => controls.stop();
    } catch {
      setScanning(false);
      setError("Kamera tidak bisa dibuka. Pakai tombol Foto atau ketik manual.");
    }
  }
  const cancelScan = () => {
    stop.current?.();
    stop.current = null;
    setScanning(false);
  };

  async function onPhoto(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    const codes = await detectCodes(f);
    setBusy(false);
    if (photo.current) photo.current.value = "";
    if (!codes.length) return setError("Barcode/QR tidak terbaca di foto. Coba lagi lebih dekat, atau ketik manual.");
    const g = classifyCodes(codes);
    const text = [g.orderNo, g.trackingNo, ...codes].filter(Boolean).join(" ");
    setQ((g.orderNo ?? g.trackingNo ?? codes[0]).slice(0, 120));
    void search(text);
  }

  const existing = picked ? [...picked.existing.returns.map((r) => `${r.number} (${r.status})`), ...picked.existing.complaints.map((c) => `${c.number} (${c.status})`)] : [];
  const dupLabel = kind === "RETUR" ? "retur" : "komplain";
  const dupExisting = picked ? (kind === "RETUR" ? picked.existing.returns : picked.existing.complaints) : [];
  return (
    <div className="space-y-2 rounded-xl border border-dashed border-sky-300 bg-sky-50/50 p-3">
      <p className="text-sm font-medium">Cari pesanan marketplace</p>
      <p className="text-xs text-slate-600">Ketik atau scan No. Pesanan / No. Resi; data pesanan (toko, kanal, resi, kota, produk &amp; qty) terisi otomatis. Scanner USB: scan lalu otomatis Enter.</p>
      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(q); } }} className="input min-w-0 flex-1 font-mono uppercase" placeholder="No. Pesanan / No. Resi" autoComplete="off" />
        <button type="button" className="btn-secondary btn-sm" disabled={busy || q.trim().length < 6} onClick={() => search(q)}>{busy ? "Mencari…" : "Cari"}</button>
        <button type="button" className="btn-primary btn-sm" onClick={scanning ? cancelScan : startScan}>{scanning ? "Tutup kamera" : "📷 Scan"}</button>
        <label className="btn-secondary btn-sm cursor-pointer">Foto<input ref={photo} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => onPhoto(e.target.files?.[0])} /></label>
      </div>
      {scanning && <video ref={video} className="mt-1 max-h-64 w-full rounded-lg bg-black object-cover" muted playsInline />}
      {error && <p className="rounded-lg bg-rose-50 px-2 py-1.5 text-xs text-rose-700">{error}</p>}
      {hits && hits.length === 0 && <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-800">Pesanan tidak ditemukan di data marketplace. Pastikan file pesanan sudah diimpor, atau isi manual di bawah.</p>}
      {hits && hits.length > 1 && (
        <ul className="divide-y rounded-lg border bg-white text-sm">
          {hits.map((h) => (
            <li key={h.id}><button type="button" className="block w-full px-3 py-2 text-left hover:bg-slate-50" onClick={() => choose(h)}><span className="font-mono text-xs">{h.orderNo}</span> · {h.store} · {h.marketplace === "SHOPEE" ? "Shopee" : "TikTok"} · {h.city ?? "-"}</button></li>
          ))}
        </ul>
      )}
      {picked && (
        <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <p className="font-medium">Terisi dari pesanan <span className="font-mono">{picked.orderNo}</span> · {picked.store} · {picked.marketplace === "SHOPEE" ? "Shopee" : "TikTok"} · {idr(picked.total)}</p>
          <p>{picked.lines.map((l) => `${l.name ?? l.sku ?? "?"} ×${l.qty}${l.itemId ? "" : " (belum dipetakan)"}`).join(", ")}</p>
          {picked.lines.some((l) => !l.itemId && !l.extra) && <p className="text-amber-800">Ada produk yang belum dipetakan: pilih produk ERP manual (atau petakan di Penjualan › Marketplace › Pemetaan SKU).</p>}
          {existing.length > 0 && <p className="mt-1 text-amber-800">Sudah tercatat: {existing.join(", ")}</p>}
          <input type="hidden" name="storeId" value={picked.storeId} />
          <input type="hidden" name="marketplaceOrderId" value={picked.id} />
          {dupExisting.length > 0 && (
            <label className="mt-1 flex items-start gap-2 text-amber-900"><input type="checkbox" name="confirmDup" className="mt-0.5" /><span>Ini {dupLabel} kedua untuk pesanan yang sama (konfirmasi agar bisa disimpan)</span></label>
          )}
        </div>
      )}
    </div>
  );
}
