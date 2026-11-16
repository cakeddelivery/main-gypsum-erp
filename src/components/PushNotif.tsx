"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CLOSE_MS } from "./Modal";
import { todayStr } from "@/lib/time";
import { InstallAppCard, isIos, isStandalone } from "./Pwa";
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

const SETUP_KEY = "mg_lengkapi_akun";

/** Daftarkan ulang perangkat diam-diam bila izin notifikasi sudah ada (sekali per sesi), mis. setelah kunci server baru */
function usePushSync(publicKey: string | null, status: Status, refresh: () => void) {
  useEffect(() => {
    if (!publicKey || (status !== "on" && status !== "granted-off")) return;
    try {
      if (sessionStorage.getItem("mg_push_synced") === "1") return;
      sessionStorage.setItem("mg_push_synced", "1");
    } catch {}
    subscribe(publicKey).then(refresh).catch(() => {});
  }, [status, publicKey, refresh]);
}

function Step({ done, icon, title, why, children }: { done: boolean; icon: string; title: string; why: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className={`flex gap-3 rounded-xl border p-3 ${done ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}>
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-lg ${done ? "bg-emerald-600 text-white" : "bg-brand-50"}`} aria-hidden>{done ? "✓" : icon}</span>
      <div className="min-w-0 flex-1">
        <div className={`font-semibold ${done ? "text-emerald-800 line-through decoration-emerald-400" : "text-slate-900"}`}>{title}</div>
        {!done && <div className="mt-0.5 text-sm text-slate-600">{why}</div>}
        {!done && children && <div className="mt-2">{children}</div>}
      </div>
    </li>
  );
}

/**
 * Kartu "Lengkapi akun Anda": satu ajakan untuk Gmail, foto profil, dan notifikasi (menggantikan 3 popup terpisah).
 * Hanya langkah yang belum selesai yang perlu dikerjakan; "Nanti saja" menyembunyikan kartu sampai besok.
 */
export function AccountSetup({ publicKey, hasEmail, hasPhoto }: { publicKey: string | null; hasEmail: boolean; hasPhoto: boolean }) {
  const { status, refresh } = usePushStatus(publicKey);
  usePushSync(publicKey, status, refresh);
  const ref = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const path = usePathname();
  // Notifikasi ikut dicek hanya bila bisa dipakai di perangkat ini
  const pushStep = status === "default" || status === "denied" || status === "ios-install" || status === "on" || status === "granted-off";
  const pushDone = status === "on";
  const steps = [!hasEmail, !hasPhoto, pushStep && !pushDone];
  const left = steps.filter(Boolean).length;
  const total = 2 + (pushStep ? 1 : 0);
  useEffect(() => {
    if (status === "loading" || left === 0 || path.startsWith("/profil")) return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(SETUP_KEY);
    } catch {}
    if (seen === todayStr()) return;
    const t = window.setTimeout(() => { if (!ref.current?.open) ref.current?.showModal(); }, 1200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const close = (then?: () => void) => {
    try {
      localStorage.setItem(SETUP_KEY, todayStr());
    } catch {}
    setClosing(true);
    window.setTimeout(() => {
      ref.current?.close();
      setClosing(false);
      then?.();
    }, CLOSE_MS);
  };
  const go = (href: string) => () => close(() => router.push(href));
  return (
    <dialog
      ref={ref}
      data-update-safe
      data-closing={closing || undefined}
      onCancel={(e) => { e.preventDefault(); close(); }}
      className="modal no-print w-[calc(100%-1.5rem)] max-w-md rounded-2xl bg-white p-0 text-slate-800 shadow-xl backdrop:bg-slate-900/50"
      aria-labelledby="lengkapi-akun"
    >
      <div className="space-y-3 p-5">
        <div>
          <h2 id="lengkapi-akun" className="text-lg font-bold text-slate-900">Lengkapi akun Anda</h2>
          <p className="text-sm text-slate-500">{total - left} dari {total} langkah selesai</p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${((total - left) / total) * 100}%` }} /></div>
        </div>
        <ul className="space-y-2">
          <Step done={hasEmail} icon="📧" title="Isi Gmail" why={<>Lupa password bisa buat sendiri lewat Gmail, dan masuk cepat dengan tombol &quot;Masuk dengan Google&quot;.</>}>
            <button type="button" className="btn-primary btn-sm" onClick={go("/profil?isi=email")}>Isi Gmail</button>
          </Step>
          <Step done={hasPhoto} icon="🙂" title="Unggah foto profil" why="Aplikasi tampil lebih profesional, dan Supervisor mudah mengenali Anda di absensi & laporan.">
            <button type="button" className="btn-primary btn-sm" onClick={go("/profil?isi=foto")}>Unggah foto</button>
          </Step>
          {pushStep && (
            <Step done={pushDone} icon="🔔" title="Aktifkan notifikasi" why="Dapat pengingat barang masuk, setoran borongan, kabar izin/sakit, dan info penting lain langsung di HP.">
              {status === "default" && (
                <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={async () => { setBusy(true); try { await enable(publicKey!); } finally { setBusy(false); refresh(); } }}>
                  {busy ? "Mengaktifkan…" : "Aktifkan notifikasi"}
                </button>
              )}
              {status === "granted-off" && <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={async () => { setBusy(true); try { await subscribe(publicKey!); } finally { setBusy(false); refresh(); } }}>Aktifkan di HP ini</button>}
              {status === "denied" && <><p className="text-sm text-slate-600">Notifikasi masih diblokir. Izinkan dari pengaturan HP/browser:</p><DeniedHelp /></>}
              {status === "ios-install" && <><p className="text-sm text-slate-600">Di iPhone, pasang ERP di Layar Utama dulu:</p><IosInstallHelp /></>}
            </Step>
          )}
        </ul>
        <div className="flex justify-end pt-1">
          <button type="button" className="btn-secondary" onClick={() => close()}>Nanti saja</button>
        </div>
      </div>
    </dialog>
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

/**
 * Portal Koordinator / Driver (tanpa menu ☰): kartu "Pasang aplikasi" + notifikasi langsung di halaman Borongan.
 * Hilang sendiri setelah aplikasi terpasang dan notifikasi aktif di HP ini.
 */
export function PortalSetup({ publicKey }: { publicKey: string | null }) {
  const { status } = usePushStatus(publicKey);
  const [standalone, setStandalone] = useState(true);
  useEffect(() => setStandalone(isStandalone()), []);
  const pushDone = status === "on" || status === "unsupported" || status === "loading";
  if (standalone && pushDone) return null;
  return (
    <div className="space-y-3">
      <InstallAppCard />
      {!pushDone && <PushSettings publicKey={publicKey} />}
    </div>
  );
}
