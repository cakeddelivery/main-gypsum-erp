"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Rekam video unboxing langsung di aplikasi:
 * - kamera belakang, tanpa tombol jeda/edit; waktu (WIB), no. retur & no. resi ditempel di gambar video (overlay)
 * - potongan video diunggah SELAMA merekam (bertahap, ±1 MB per kiriman); sinyal putus → dicoba lagi otomatis
 * - sisa yang belum terunggah disimpan sementara di penyimpanan aplikasi (IndexedDB), BUKAN di galeri HP, dan
 *   dihapus setelah terunggah; bila halaman tertutup, unggahan bisa dilanjutkan saat retur dibuka lagi
 */
const CHUNK = 1024 * 1024;
const DB = "mg-retur-video";
type Pending = { mediaId: string; returnId: string; base: number; blob: Blob; total: number; ended: boolean; durationSec: number; mime: string };

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("pending", { keyPath: "mediaId" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const t = db.transaction("pending", mode);
      const q = fn(t.objectStore("pending"));
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  } catch {
    return undefined;
  }
}
const savePending = (p: Pending) => idbDo("readwrite", (s) => s.put(p));
const dropPending = (id: string) => idbDo("readwrite", (s) => s.delete(id));
const listPending = async (returnId: string) => ((await idbDo<Pending[]>("readonly", (s) => s.getAll() as IDBRequest<Pending[]>)) ?? []).filter((p) => p.returnId === returnId);

const MIMES = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const pickMime = () => MIMES.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
const mb = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function VideoRecorder({ returnId, number, trackingNo, autoStart }: { returnId: string; number: string; trackingNo: string; autoStart?: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "uploading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stat, setStat] = useState({ recorded: 0, sent: 0, offline: false });
  const [resume, setResume] = useState<Pending[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const st = useRef<{ p: Pending | null; pumping: boolean; stream?: MediaStream; rec?: MediaRecorder; draw?: number; tick?: number; wake?: { release(): Promise<void> } | null; t0: number; maxSec: number; frames: number; failed?: boolean }>({ p: null, pumping: false, t0: 0, maxSec: 300, frames: 0 });

  useEffect(() => {
    listPending(returnId).then(setResume);
    const s = st.current;
    return () => stopDevices(s);
  }, [returnId]);

  function stopDevices(s = st.current) {
    if (s.draw) clearInterval(s.draw);
    if (s.tick) clearInterval(s.tick);
    s.stream?.getTracks().forEach((t) => t.stop());
    s.wake?.release().catch(() => {});
    s.wake = null;
  }

  /** Kirim sisa video ke server berurutan; sinyal putus → tunggu lalu coba lagi (sampai halaman ditutup) */
  async function pump() {
    const s = st.current;
    if (s.pumping) return;
    s.pumping = true;
    let wait = 1000;
    try {
      while (s.p && s.p.blob.size > 0) {
        const p = s.p;
        const part = p.blob.slice(0, CHUNK);
        try {
          const res = await fetch(`/api/retur/media/${p.mediaId}?offset=${p.base}`, { method: "PUT", body: part, headers: { "content-type": "application/octet-stream" } });
          const j = (await res.json().catch(() => ({}))) as { received?: number; error?: string };
          if (res.ok) {
            p.blob = p.blob.slice(part.size);
            p.base += part.size;
          } else if (res.status === 409 && typeof j.received === "number") {
            // Server punya posisi lain (kiriman sebelumnya ternyata sampai): sesuaikan
            if (j.received >= p.base && j.received <= p.base + p.blob.size) {
              p.blob = p.blob.slice(j.received - p.base);
              p.base = j.received;
            } else throw new Error(`Unggahan tidak sinkron (server ${j.received}, HP ${p.base}). Rekam ulang.`);
          } else if (res.status === 401 || res.status === 403 || res.status === 413) {
            throw new Error(j.error ?? `Ditolak server (${res.status})`);
          } else throw Object.assign(new Error(j.error ?? `HTTP ${res.status}`), { retry: true });
          wait = 1000;
          setStat((x) => ({ ...x, sent: p.base, offline: false }));
          await savePending(p);
        } catch (e) {
          if (!(e as { retry?: boolean }).retry && !(e instanceof TypeError)) throw e;
          setStat((x) => ({ ...x, offline: true }));
          await sleep(wait);
          wait = Math.min(wait * 2, 15000);
        }
      }
    } catch (e) {
      s.failed = true;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      s.pumping = false;
    }
  }

  async function finish(p: Pending) {
    while (p.blob.size > 0) {
      await pump();
      if (st.current.failed) return;
      if (p.blob.size > 0) await sleep(1000);
    }
    for (let wait = 1000; ; wait = Math.min(wait * 2, 15000)) {
      try {
        const res = await fetch(`/api/retur/media/${p.mediaId}?finish=1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ total: p.total, durationSec: p.durationSec }) });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw Object.assign(new Error(j.error ?? `HTTP ${res.status}`), { retry: res.status >= 500 });
        break;
      } catch (e) {
        if (!(e as { retry?: boolean }).retry && !(e instanceof TypeError)) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
          return;
        }
        setStat((x) => ({ ...x, offline: true }));
        await sleep(wait);
      }
    }
    await dropPending(p.mediaId);
    st.current.p = null;
    setPhase("done");
    router.refresh();
  }

  function frame(kind: "thumb" | "frame") {
    const c = canvasRef.current;
    if (!c || st.current.frames >= 12) return;
    st.current.frames++;
    const small = document.createElement("canvas");
    const s = Math.min(1, 640 / Math.max(c.width, c.height));
    small.width = Math.round(c.width * s);
    small.height = Math.round(c.height * s);
    small.getContext("2d")!.drawImage(c, 0, 0, small.width, small.height);
    small.toBlob((b) => b && fetch(`/api/retur/${returnId}/frame`, { method: "POST", body: b, headers: { "content-type": "image/jpeg", "x-kind": kind } }).catch(() => {}), "image/jpeg", 0.7);
  }

  async function start() {
    setError(null);
    setPhase("starting");
    const s = st.current;
    s.failed = false;
    try {
      const mime = pickMime();
      if (!mime) throw new Error("HP/browser ini belum bisa merekam video. Pakai Chrome terbaru (Android) atau Safari iOS 14.5+.");
      const video = { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } };
      // Suara ikut direkam bila mikrofon diizinkan; bila ditolak tetap rekam gambar saja
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: true }).catch((e) => (/NotAllowed|Permission/i.test(String(e)) ? navigator.mediaDevices.getUserMedia({ video, audio: false }) : Promise.reject(e)));
      s.stream = stream;
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      const vw = v.videoWidth || 1280;
      const vh = v.videoHeight || 720;
      const scale = Math.min(1, 1280 / Math.max(vw, vh));
      const c = canvasRef.current!;
      c.width = Math.round((vw * scale) / 2) * 2;
      c.height = Math.round((vh * scale) / 2) * 2;
      const ctx = c.getContext("2d")!;
      const fs = Math.max(16, Math.round(c.width / 36));
      s.t0 = Date.now();
      const drawFrame = () => {
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const now = new Date();
        const t = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const lines = [`${number} · Resi ${trackingNo}`, `${t} WIB · ● REC ${clock(Math.floor((Date.now() - s.t0) / 1000))}`];
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0, c.height - fs * 3.2, c.width, fs * 3.2);
        ctx.fillStyle = "#fff";
        ctx.font = `600 ${fs}px system-ui, sans-serif`;
        lines.forEach((l, i) => ctx.fillText(l, fs * 0.6, c.height - fs * (2.0 - i * 1.25)));
      };
      drawFrame();
      s.draw = window.setInterval(drawFrame, 1000 / 24);
      const out = c.captureStream(24);
      stream.getAudioTracks().forEach((t) => out.addTrack(t));
      const res = await fetch(`/api/retur/${returnId}/video`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mime, recordedAt: new Date().toISOString(), device: navigator.userAgent }) });
      const j = (await res.json()) as { mediaId?: string; maxMinutes?: number; error?: string };
      if (!res.ok || !j.mediaId) throw new Error(j.error ?? "Gagal memulai unggahan");
      s.maxSec = (j.maxMinutes ?? 5) * 60;
      s.p = { mediaId: j.mediaId, returnId, base: 0, blob: new Blob([], { type: mime }), total: 0, ended: false, durationSec: 0, mime: mime.split(";")[0] };
      s.frames = 0;
      const rec = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 });
      s.rec = rec;
      rec.ondataavailable = (e) => {
        const p = s.p;
        if (!p || !e.data.size) return;
        p.blob = new Blob([p.blob, e.data], { type: p.mime });
        p.total += e.data.size;
        setStat((x) => ({ ...x, recorded: p.total }));
        void savePending(p);
        void pump();
      };
      rec.onstop = () => {
        const p = s.p;
        stopDevices();
        if (!p) return;
        p.ended = true;
        p.durationSec = Math.round((Date.now() - s.t0) / 1000);
        void savePending(p);
        setPhase("uploading");
        void finish(p);
      };
      rec.start(3000);
      s.wake = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen").catch(() => null) ?? null;
      setElapsed(0);
      setPhase("recording");
      setTimeout(() => frame("thumb"), 1500);
      s.tick = window.setInterval(() => {
        const sec = Math.floor((Date.now() - s.t0) / 1000);
        setElapsed(sec);
        if (sec > 0 && sec % 30 === 0) frame("frame");
        if (sec >= s.maxSec && rec.state === "recording") stop();
      }, 1000);
    } catch (e) {
      stopDevices();
      const m = e instanceof Error ? e.message : String(e);
      setError(/Permission|NotAllowed/i.test(m) ? "Izin kamera/mikrofon ditolak. Buka pengaturan situs di browser lalu izinkan kamera & mikrofon." : m);
      setPhase("error");
    }
  }

  function stop() {
    frame("frame");
    const r = st.current.rec;
    if (r && r.state !== "inactive") r.stop();
  }

  async function continueUpload(p: Pending) {
    setError(null);
    st.current.failed = false;
    st.current.p = p;
    setStat({ recorded: p.total, sent: p.base, offline: false });
    setPhase("uploading");
    const res = await fetch(`/api/retur/media/${p.mediaId}`).then((r) => r.json()).catch(() => null) as { status?: string; received?: number } | null;
    if (res?.status && res.status !== "UPLOADING") {
      await dropPending(p.mediaId);
      setResume((x) => x.filter((y) => y.mediaId !== p.mediaId));
      setPhase("done");
      router.refresh();
      return;
    }
    if (typeof res?.received === "number" && res.received > p.base && res.received <= p.base + p.blob.size) {
      p.blob = p.blob.slice(res.received - p.base);
      p.base = res.received;
    }
    p.ended = true;
    p.durationSec ||= 0;
    setResume((x) => x.filter((y) => y.mediaId !== p.mediaId));
    await finish(p);
  }

  const recording = phase === "recording";
  return (
    <div className="space-y-2">
      {resume.map((p) => (
        <div key={p.mediaId} className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
          Ada video yang belum selesai terunggah ({mb(p.base)} dari {mb(p.total)}).{" "}
          <button type="button" className="btn-primary btn-sm" onClick={() => continueUpload(p)}>Lanjutkan unggah</button>
        </div>
      ))}
      {(phase === "idle" || phase === "error" || phase === "done") && (
        <button type="button" className="btn-primary" onClick={start} autoFocus={autoStart}>🎥 {phase === "done" ? "Rekam video lagi" : "Rekam video unboxing"}</button>
      )}
      {phase === "done" && <p className="text-sm text-emerald-700">✓ Video terunggah. Sedang dikompres di server; thumbnail muncul sebentar lagi.</p>}
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">⚠️ {error}</p>}
      <video ref={videoRef} playsInline muted className="hidden" />
      <div className={recording || phase === "starting" ? "fixed inset-0 z-[70] flex flex-col bg-black" : "hidden"}>
        <canvas ref={canvasRef} className="min-h-0 w-full flex-1 object-contain" />
        <div className="flex items-center justify-between gap-3 p-4 text-white">
          <div className="text-sm">
            <div className="font-semibold"><span className="text-rose-500">●</span> {clock(elapsed)} <span className="font-normal opacity-70">/ maks {clock(st.current.maxSec)}</span></div>
            <div className="text-xs opacity-80">Terunggah {mb(stat.sent)} dari {mb(stat.recorded)}{stat.offline ? " · sinyal putus, mencoba lagi…" : ""}</div>
          </div>
          <button type="button" onClick={stop} disabled={!recording} className="rounded-full bg-rose-600 px-6 py-3 text-base font-semibold text-white disabled:opacity-50">■ Selesai rekam</button>
        </div>
        <p className="px-4 pb-4 text-xs text-white/70">Tunjukkan label resi dulu, lalu buka paket tanpa terputus. Video tidak tersimpan di galeri HP.</p>
      </div>
      {phase === "uploading" && (
        <p className="text-sm text-slate-700">⏳ Mengunggah sisa video: {mb(stat.sent)} dari {mb(stat.recorded)}{stat.offline ? " · sinyal putus, mencoba lagi otomatis (jangan tutup halaman)" : ""}</p>
      )}
    </div>
  );
}
