"use client";
import { useCallback, useEffect, useState } from "react";
import { isIos, isStandalone } from "./Pwa";
import { removePushSubscription, savePushSubscription, sendTestPush } from "@/app/(app)/profil/pushActions";

type Status = "loading" | "unsupported" | "ios-install" | "default" | "denied" | "granted-off" | "on";

function keyBytes(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function currentSub() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Langganan perangkat ini lalu simpan ke server (setelah izin diberikan) */
async function subscribe(publicKey: string) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await savePushSubscription({ endpoint: json.endpoint, keys: json.keys });
  return sub;
}

/** Status notifikasi di perangkat ini */
function usePushStatus(publicKey: string | null) {
  const [status, setStatus] = useState<Status>("loading");
  const refresh = useCallback(async () => {
    if (!publicKey) return setStatus("unsupported");
    if (isIos() && !isStandalone()) return setStatus("ios-install");
    if (!supported() || process.env.NODE_ENV !== "production") return setStatus("unsupported");
    const perm = Notification.permission;
    if (perm === "denied") return setStatus("denied");
    if (perm === "default") return setStatus("default");
    setStatus((await currentSub()) ? "on" : "granted-off");
  }, [publicKey]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { status, refresh };
}

async function enable(publicKey: string) {
  // Harus dipanggil dari ketukan pengguna (browser menolak permintaan izin otomatis)
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm;
  await subscribe(publicKey);
  return "granted";
}

function DeniedHelp() {
  return (
    <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
      <li><b>Android (Chrome):</b> ketuk ikon ⓘ / gembok di sebelah alamat (atau tahan ikon aplikasi → Info aplikasi) → <b>Notifikasi</b> → <b>Izinkan</b>.</li>
      <li><b>iPhone:</b> Pengaturan → <b>Notifikasi</b> → <b>MG ERP</b> → nyalakan <b>Izinkan Notifikasi</b>.</li>
      <li>Setelah itu buka lagi aplikasinya.</li>
    </ul>
  );
}

function IosInstallHelp() {
  return (
    <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">
      <li>Buka ERP di <b>Safari</b>, ketuk tombol <b>Bagikan</b> (kotak berpanah ke atas).</li>
      <li>Pilih <b>Tambah ke Layar Utama</b> → <b>Tambah</b> (iOS 16.4 ke atas).</li>
      <li>Buka ERP dari ikon <b>MG ERP</b> di layar utama, lalu aktifkan notifikasi.</li>
    </ol>
  );
}

const DISMISS = "mg_push_prompt_dismissed";

/**
 * Ajakan aktifkan notifikasi: muncul setiap kali aplikasi dibuka selama izin belum diberikan
 * (bisa ditutup untuk sesi ini). Izin diminta lewat tombol (ketukan pengguna), tidak otomatis.
 * Bila izin sudah ada tetapi perangkat belum terdaftar (mis. kunci server baru), didaftarkan diam-diam.
 */
export function PushPrompt({ publicKey }: { publicKey: string | null }) {
  const { status, refresh } = usePushStatus(publicKey);
  const [hidden, setHidden] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem(DISMISS) === "1";
    } catch {}
    const t = window.setTimeout(() => setHidden(dismissed), 1500);
    return () => window.clearTimeout(t);
  }, []);
  // Izin sudah diberikan: pastikan langganan perangkat ini tersimpan di server (sekali per sesi)
  useEffect(() => {
    if (!publicKey || (status !== "on" && status !== "granted-off")) return;
    try {
      if (sessionStorage.getItem("mg_push_synced") === "1") return;
      sessionStorage.setItem("mg_push_synced", "1");
    } catch {}
    subscribe(publicKey).then(refresh).catch(() => {});
  }, [status, publicKey, refresh]);

  const show = !hidden && (status === "default" || status === "denied" || status === "ios-install");
  if (!show) return null;
  const close = () => {
    setHidden(true);
    try {
      sessionStorage.setItem(DISMISS, "1");
    } catch {}
  };
  return (
    <div role="dialog" aria-labelledby="push-ajak" className="no-print fixed inset-x-3 bottom-24 z-40 mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-4 text-slate-700 shadow-2xl sm:bottom-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-50 text-xl" aria-hidden>🔔</span>
        <div className="min-w-0 flex-1">
          <p id="push-ajak" className="font-semibold text-slate-900">
            {status === "denied" ? "Notifikasi masih diblokir" : status === "ios-install" ? "Pasang ERP agar bisa menerima notifikasi" : "Aktifkan notifikasi"}
          </p>
          {status === "default" && <p className="mt-1 text-sm">Dapat pengingat barang masuk & setoran borongan, kabar laporan, dan info penting lain langsung di HP, walau aplikasi sedang ditutup.</p>}
          {status === "denied" && <><p className="mt-1 text-sm">Izinkan notifikasi dari pengaturan HP/browser:</p><DeniedHelp /></>}
          {status === "ios-install" && <><p className="mt-1 text-sm">Di iPhone, notifikasi hanya bisa diterima dari ERP yang dipasang di Layar Utama:</p><IosInstallHelp /></>}
          <div className="mt-3 flex flex-wrap gap-2">
            {status === "default" && (
              <button type="button" className="btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { await enable(publicKey!); } finally { setBusy(false); refresh(); } }}>
                {busy ? "Mengaktifkan…" : "Aktifkan notifikasi"}
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={close}>{status === "default" ? "Nanti" : "Tutup"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Pengaturan notifikasi di Profil: status perangkat ini, aktif/nonaktif, dan kirim tes */
export function PushSettings({ publicKey }: { publicKey: string | null }) {
  const { status, refresh } = usePushStatus(publicKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Gagal, coba lagi." });
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const label: Record<Status, string> = {
    loading: "Memeriksa…",
    unsupported: publicKey ? "Browser ini belum mendukung notifikasi. Pakai Chrome (Android) atau ERP yang dipasang di Layar Utama (iPhone)." : "Notifikasi belum disiapkan di server. Minta Admin memasang kunci VAPID.",
    "ios-install": "Di iPhone, pasang ERP ke Layar Utama dulu (iOS 16.4+), lalu buka dari ikonnya.",
    default: "Belum aktif di perangkat ini.",
    denied: "Diblokir di pengaturan HP/browser.",
    "granted-off": "Diizinkan, tetapi perangkat ini belum terdaftar.",
    on: "Aktif di perangkat ini.",
  };
  return (
    <div className="space-y-3 text-sm text-slate-700">
      <p><span className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${status === "on" ? "bg-emerald-500" : status === "denied" ? "bg-rose-500" : "bg-slate-300"}`} aria-hidden />{label[status]}</p>
      {status === "denied" && <DeniedHelp />}
      {status === "ios-install" && <IosInstallHelp />}
      <div className="flex flex-wrap gap-2">
        {(status === "default" || status === "granted-off") && (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => run(async () => { const r = await enable(publicKey!); setMsg(r === "granted" ? { ok: true, text: "Notifikasi aktif di perangkat ini." } : { ok: false, text: "Izin notifikasi tidak diberikan." }); })}>
            Aktifkan notifikasi
          </button>
        )}
        {status === "on" && (
          <>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(async () => { const r = await sendTestPush(); setMsg({ ok: r.ok, text: r.message }); })}>Kirim tes</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(async () => { const sub = await currentSub(); if (sub) { await removePushSubscription(sub.endpoint); await sub.unsubscribe(); } setMsg({ ok: true, text: "Notifikasi dimatikan di perangkat ini." }); })}>Nonaktifkan di perangkat ini</button>
          </>
        )}
      </div>
      {msg && <p role="status" className={msg.ok ? "text-emerald-700" : "text-rose-700"}>{msg.text}</p>}
    </div>
  );
}
