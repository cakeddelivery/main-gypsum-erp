"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";
import { detectSlotsAction, finishImportJobAction, previewMarketplaceAction, saveOneFileAction, startImportJobAction, type PreviewResult } from "../actions";
import { toast } from "@/components/Toaster";

const KIND = { ORDER: "Pesanan", INCOME: "Penghasilan", BALANCE: "Buku Saldo Penjual", ADSBILL: "Saldo iklan" } as const;
const CH = { SHP: "Shopee", TTS: "TikTok" } as const;
const nf = (v: number) => v.toLocaleString("id-ID");

export type SlotInfo = { key: string; label: string; example: string; steps: string[] };
export type Card = { storeId: string; storeName: string; channel: "SHP" | "TTS"; slots: (SlotInfo & { lastAt: string | null; lastFile: string | null; periodFrom: string | null; periodTo: string | null })[] };

const fmtD = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Jakarta" }) : "-");
const ageDays = (iso: string | null) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null);

/** Kartu per toko × kanal, tiap jenis file punya slot sendiri. Pratinjau tidak menulis apa pun; Simpan membaca ulang file di server. */
export function ImportForm({ cards, canManage }: { cards: Card[]; canManage: boolean }) {
  const [slots, setSlots] = useState<Record<string, File>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [res, setRes] = useState<PreviewResult | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const count = Object.keys(slots).length;
  type Prog = { id: string; name: string; state: "tunggu" | "jalan" | "ok" | "gagal" | "lewat"; text: string };
  const [prog, setProg] = useState<Prog[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [after, setAfter] = useState<{ failed?: number; total?: number; month?: string; ok: boolean } | null>(null);
  // Tahan refresh/tutup tab selama proses berjalan
  useEffect(() => {
    if (!busy && !pending) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = "Proses impor masih berjalan. Jika halaman ditutup, file yang belum tersimpan akan terlewat."; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [busy, pending]);
  const kindOf = (id: string) => id.split("|")[2];
  const slotLabel = (id: string) => { const [st, ch, k] = id.split("|"); const c = cards.find((x) => x.storeId === st && x.channel === ch); return `${c?.storeName ?? ""} · ${ch === "SHP" ? "Shopee" : "TikTok"} · ${c?.slots.find((x) => x.key === k)?.label ?? k}`; };

  const fd = () => {
    const f = new FormData();
    for (const [id, file] of Object.entries(slots)) {
      f.append("file", file);
      f.append("storeId", id.split("|")[0]);
    }
    return f;
  };
  const reset = () => { setRes(null); setSaved(null); };

  /** Jatuhkan/pilih file ke slot tertentu: dicek jenis & toko di server, ditolak bila salah */
  const putInSlot = (id: string, file: File) =>
    start(async () => {
      reset();
      const f = new FormData();
      f.append("file", file);
      f.append("target", id);
      const r = await detectSlotsAction(f);
      const d = r.items?.[0];
      const err = !r.ok ? r.error : d?.error;
      if (err) { setProblems((c) => ({ ...c, [id]: `${file.name}: ${err}` })); return; }
      setProblems((c) => { const n = { ...c }; delete n[id]; return n; });
      setSlots((c) => ({ ...c, [id]: file }));
    });

  /** Banyak file sekaligus: disortir otomatis ke slot menurut jenis & username penjual */
  const autoSort = (list: FileList | null) => {
    const files = [...(list ?? [])].filter((f) => /\.(xlsx|csv)$/i.test(f.name)).slice(0, 12);
    if (!files.length) return;
    start(async () => {
      reset();
      const f = new FormData();
      for (const x of files) f.append("file", x);
      const r = await detectSlotsAction(f);
      if (!r.ok || !r.items) { setNotes([r.error ?? "Gagal membaca file"]); return; }
      const msgs: string[] = [];
      const add: Record<string, File> = {};
      r.items.forEach((d, i) => {
        if (d.error || !d.storeId || !d.channel || !d.kind) { msgs.push(`${files[i].name}: ${d.error ?? "tidak dikenali"}`); return; }
        add[`${d.storeId}|${d.channel}|${d.kind}`] = files[i];
        msgs.push(`${files[i].name} → ${cards.find((c) => c.storeId === d.storeId && c.channel === d.channel)?.storeName ?? ""} · ${d.channel === "SHP" ? "Shopee" : "TikTok"} · ${cards.find((c) => c.channel === d.channel)?.slots.find((x) => x.key === d.kind)?.label ?? d.kind}`);
      });
      setSlots((c) => ({ ...c, ...add }));
      setNotes(msgs);
    });
  };
  const preview = () =>
    start(async () => {
      setSaved(null);
      setRes(await previewMarketplaceAction(fd()));
    });
  /** Simpan file satu per satu (pesanan dulu): progres nyata per file, tombol terkunci selama proses */
  const save = async () => {
    const ids = Object.keys(slots).sort((x, y) => (kindOf(x) === "ORDER" ? 0 : 1) - (kindOf(y) === "ORDER" ? 0 : 1));
    const rows: Prog[] = ids.map((id) => ({ id, name: `${slots[id].name} — ${slotLabel(id)}`, state: "tunggu", text: "menunggu" }));
    setProg(rows); setAfter(null); setBusy(true); setSaved(null);
    const set = (i: number, state: Prog["state"], text: string) => { rows[i] = { ...rows[i], state, text }; setProg([...rows]); };
    const job = await startImportJobAction(ids.length, slotLabel(ids[0]));
    if (!job.ok || !job.id) { setRes({ ok: false, error: job.error ?? "Gagal memulai impor" }); setProg(null); setBusy(false); return; }
    let okAll = true, baru = 0, upd = 0, skip = 0;
    for (let i = 0; i < ids.length; i++) {
      if (!okAll) { set(i, "lewat", "dilewati karena file sebelumnya gagal"); continue; }
      set(i, "jalan", "mengunggah, membaca, mencocokkan & menyimpan…");
      const f = new FormData();
      f.append("file", slots[ids[i]]); f.append("storeId", ids[i].split("|")[0]); f.append("jobId", job.id); f.append("done", String(i + 1));
      let r: Awaited<ReturnType<typeof saveOneFileAction>>;
      try { r = await saveOneFileAction(f); } catch { r = { ok: false, error: "Koneksi terputus saat menyimpan" }; }
      if (r.ok) { baru += r.baru ?? 0; upd += r.diperbarui ?? 0; skip += r.dilewati ?? 0; set(i, "ok", `${r.baru} baru · ${r.diperbarui} diperbarui · ${r.dilewati} dilewati`); }
      else { okAll = false; set(i, "gagal", r.error ?? "gagal"); }
    }
    const msg = okAll ? `Impor tersimpan: ${baru} baru, ${upd} diperbarui, ${skip} dilewati (sama persis)` : "Impor berhenti karena ada file yang gagal";
    const fin = await finishImportJobAction(job.id, okAll, msg);
    setAfter({ ok: okAll, failed: fin.failed, total: fin.total, month: fin.month });
    setBusy(false);
    if (okAll) { toast(msg); setSaved(msg); setSlots({}); setNotes([]); setRes(null); }
    router.refresh();
  };
  const done = prog ? prog.filter((x) => x.state === "ok" || x.state === "gagal" || x.state === "lewat").length : 0;

  if (!canManage) return <p className="text-sm text-slate-500">Hanya pengguna dengan izin kelola penjualan yang bisa mengimpor.</p>;
  const p = res?.preview;
  return (
    <div className="space-y-4">
      <div
        className="rounded-xl border-2 border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); autoSort(e.dataTransfer.files); }}
      >
        <p>Punya banyak file? Tarik semuanya ke sini — otomatis masuk ke slot yang benar.</p>
        <label className="btn-secondary mt-2 inline-block cursor-pointer">
          Pilih banyak file
          <input type="file" accept=".xlsx,.csv" multiple hidden onChange={(e) => { autoSort(e.target.files); e.target.value = ""; }} />
        </label>
        <p className="mt-1 text-xs text-slate-400">File yang tidak memuat nama toko (pesanan, TikTok) dijatuhkan langsung ke slot di kartu toko.</p>
      </div>
      {notes.length > 0 && <ul className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}

      <div className="grid gap-3 lg:grid-cols-2">
        {cards.map((c) => (
          <div key={`${c.storeId}|${c.channel}`} className="card space-y-2 p-3">
            <p className="font-semibold">{c.storeName} · {c.channel === "SHP" ? "Shopee" : "TikTok Shop"}</p>
            {c.slots.map((sl) => {
              const id = `${c.storeId}|${c.channel}|${sl.key}`;
              const file = slots[id];
              const age = ageDays(sl.lastAt);
              return (
                <div
                  key={id}
                  className={`rounded-lg border p-2 text-sm ${problems[id] ? "border-rose-300 bg-rose-50" : file ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white"}`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (f) putInSlot(id, f); }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <b className="flex-1">{sl.label}</b>
                    {file ? <button type="button" className="btn-secondary btn-sm" onClick={() => { setSlots((x) => { const n = { ...x }; delete n[id]; return n; }); reset(); }}>Hapus</button> : (
                      <label className="btn-secondary btn-sm cursor-pointer">Pilih file<input type="file" accept=".xlsx,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) putInSlot(id, f); }} /></label>
                    )}
                  </div>
                  <p className="break-all text-xs text-slate-400">Contoh: {sl.example}</p>
                  {file && <p className="break-all text-xs text-emerald-700">✓ {file.name}</p>}
                  {problems[id] && <p className="mt-1 text-xs font-medium text-rose-700">⛔ {problems[id]}</p>}
                  <p className={`text-xs ${age === null ? "text-slate-400" : age > 3 ? "text-amber-700" : "text-slate-500"}`}>
                    {sl.lastAt ? `Terakhir diunggah ${fmtD(sl.lastAt)}${age ? ` (${age} hari lalu)` : " (hari ini)"}${sl.periodTo ? ` · periode ${fmtD(sl.periodFrom)} – ${fmtD(sl.periodTo)}` : ""}` : "Belum pernah diunggah"}
                  </p>
                  <details className="text-xs text-slate-500">
                    <summary className="cursor-pointer text-sky-700">Cara unduh</summary>
                    <ol className="mt-1 list-decimal space-y-0.5 pl-4">{sl.steps.map((t, i) => <li key={i}>{t}</li>)}</ol>
                    <p className="mt-1 text-slate-400">Letak menu di Seller Center bisa sedikit berbeda; yang penting nama file mirip contoh.</p>
                  </details>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {count > 0 && (
        <div className="flex items-center gap-2">
          <button type="button" className="btn-primary" disabled={pending || busy} onClick={preview}>{pending && !p ? "Membaca…" : `Pratinjau ${count} file`}</button>
        </div>
      )}

      {(pending && !prog && !p && count > 0) && <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800"><p>Membaca & mencocokkan {count} file dengan data yang sudah ada…</p><div className="mt-2 h-2 overflow-hidden rounded bg-sky-100"><div className="h-2 w-1/3 animate-pulse rounded bg-sky-500" /></div></div>}
      {prog && (
        <div className="card space-y-2 p-3 text-sm">
          <div className="flex items-center justify-between"><b>{busy ? "Impor sedang berjalan — jangan tutup atau muat ulang halaman" : after?.ok ? "Impor selesai ✓" : "Impor berhenti ✗"}</b><span className="tabular-nums text-xs text-slate-500">{done}/{prog.length} file · {Math.round((done / prog.length) * 100)}%</span></div>
          <div className="h-2 overflow-hidden rounded bg-slate-100"><div className={`h-2 rounded transition-all ${after && !after.ok ? "bg-rose-500" : "bg-emerald-500"}`} style={{ width: `${Math.max(busy ? 5 : 0, (done / prog.length) * 100)}%` }} /></div>
          <ul className="space-y-1">{prog.map((x) => <li key={x.id} className={`rounded px-2 py-1 text-xs ${x.state === "ok" ? "bg-emerald-50 text-emerald-800" : x.state === "gagal" ? "bg-rose-50 text-rose-800" : x.state === "jalan" ? "bg-sky-50 text-sky-800" : "bg-slate-50 text-slate-500"}`}>{x.state === "ok" ? "✓" : x.state === "gagal" ? "✗" : x.state === "jalan" ? "⏳" : "•"} <b className="break-all">{x.name}</b> — {x.text}</li>)}</ul>
          {after && <p className="text-xs text-slate-600">{after.total ? `Cek integritas ${after.month}: ${after.failed ? `${after.failed} dari ${after.total} pemeriksaan perlu dilihat` : "semua lolos"}. ` : ""}<Link className="link" href="/penjualan/marketplace/rekon">Buka Cek Integritas →</Link></p>}
        </div>
      )}
      {saved && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{saved}</div>}
      {res && !res.ok && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{res.error}</div>}
      {res?.fileErrors?.map((e) => <div key={e.fileName} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><b>{e.fileName}</b>: {e.error}</div>)}

      {p && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["Pesanan/baris baru", p.totals.baru], ["Diperbarui status", p.totals.diperbarui], ["Dilewati (sama persis)", p.totals.dilewati], ["Perlu dicek", p.totals.perluDicek]].map(([l, v]) => (
              <div key={l as string} className="card p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-xl font-semibold tabular-nums">{nf(v as number)}</p></div>
            ))}
          </div>
          {p.files.map((f, i) => (
            <div key={i} className="card space-y-2 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <b className="break-all">{f.fileName}</b>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{CH[f.channel as "SHP" | "TTS"]} · {KIND[f.kind as keyof typeof KIND] ?? f.kind}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{f.storeName}</span>
                {f.periodFrom && <span className="text-xs text-slate-500">{f.periodFrom} s/d {f.periodTo}</span>}
              </div>
              {f.error && <p className="rounded bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700">⛔ {f.error}</p>}
              {f.note && <p className="rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">{f.note}</p>}
              {f.seller && <p className="text-xs text-slate-500">Penjual di file: {f.seller}</p>}
              {f.sheets && <p className="text-xs text-slate-600">Sheet dibaca: {f.sheets.read.join(", ")}{f.sheets.skipped.length > 0 && <> · dilewati: {f.sheets.skipped.map((x) => `${x.name} (${x.reason})`).join("; ")}</>}</p>}
              {f.personalCols && f.personalCols.length > 0 && <p className="text-xs text-slate-500">Kolom sengaja tidak disimpan (data pribadi): {f.personalCols.join(", ")}</p>}
              {f.extras && <p className="rounded bg-sky-50 px-2 py-1 text-xs text-sky-800">Sheet tambahan: Selisih ongkir {nf(f.extras.shipDisc)} pesanan ({nf(f.extras.shipDiscBaru)} baru) · Seller Fee {nf(f.extras.sellerFee)} pesanan ({nf(f.extras.sellerFeeBaru)} baru)</p>}
              <p>{nf(f.total)} {f.kind === "ORDER" ? "pesanan" : "baris"}: <b>{nf(f.baru)}</b> baru, <b>{nf(f.diperbarui)}</b> diperbarui, {nf(f.dilewati)} dilewati{f.adsRows ? ` · ${f.adsRows} potongan iklan/penyesuaian` : ""}{f.withdrawals ? ` · ${f.withdrawals} penarikan` : ""}</p>
              {Object.keys(f.changes).length > 0 && <p className="rounded bg-sky-50 px-2 py-1 text-xs text-sky-800">Perubahan pada pesanan yang sudah ada: {Object.entries(f.changes).map(([k, v]) => `${k}: ${nf(v)}`).join(" · ")}</p>}
              {f.incomeNoOrder > 0 && <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">{nf(f.incomeNoOrder)} penghasilan belum punya pesanan di ERP — tetap disimpan, cocok otomatis saat file pesanannya diunggah.</p>}
              {f.unmapped.length > 0 && (
                <div className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  <p className="font-medium">{f.unmapped.length} SKU belum dipetakan ke produk (tetap bisa disimpan; petakan di menu Pemetaan SKU):</p>
                  <ul className="mt-1 list-disc pl-4">{f.unmapped.slice(0, 8).map((u) => <li key={u.key}>{u.sku} {u.name ? `· ${u.name}` : ""} ({u.orders} pesanan)</li>)}{f.unmapped.length > 8 && <li>… dan {f.unmapped.length - 8} lainnya</li>}</ul>
                </div>
              )}
            </div>
          ))}
          <p className="text-xs text-slate-500">Menyimpan hanya mencatat penjualan marketplace. Stok dan jurnal keuangan tidak berubah. Setiap file menjadi satu batch yang bisa dibatalkan.</p>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" disabled={pending || busy || !!res?.fileErrors?.length || !!p.files.some((x) => x.error)} onClick={save}>{busy ? "Menyimpan…" : "Simpan impor"}</button>
            <button type="button" className="btn-secondary" disabled={pending || busy} onClick={() => setRes(null)}>Batal</button>
          </div>
          {!!res?.fileErrors?.length && <p className="text-xs text-amber-700">Hapus file yang bermasalah dulu agar semua file bisa disimpan bersama.</p>}
        </div>
      )}
    </div>
  );
}
