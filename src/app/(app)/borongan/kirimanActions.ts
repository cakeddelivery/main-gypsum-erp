"use server";
import { action, optStr, str } from "@/lib/action";
import { prisma } from "@/lib/db";
import { BoronganError, boronganScope } from "@/lib/borongan";
import { cancelPickup, cancelShipment, createPickup, createShipment, receivePickup, resolvePickup, saveAllots, saveWorkReport } from "@/lib/boronganFlow";
import { todayStr } from "@/lib/time";
import { autoClaims } from "@/lib/boronganClaim";
import { FieldError } from "@/lib/fieldError";

/** Alur kiriman borongan (KRM → bagi → lapor → AMB → terima). Driver punya izin borongan.driver. */
const PERMS = ["borongan.manage", "borongan.point", "borongan.driver"] as const;
const PATHS = ["/borongan", "/stok", "/laporan"];
const int = (v: FormDataEntryValue | null) => {
  const n = Number(String(v ?? "").replace(/\./g, "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const dec = (v: FormDataEntryValue | null) => Number(String(v ?? "").replace(/\./g, "").replace(",", ".").trim()) || 0;
const fmt = (n: number) => n.toLocaleString("id-ID");

export const kirimBahan = action(
  [...PERMS],
  async (fd, user) => {
    const scope = await boronganScope(prisma, user);
    const tasks: { taskId: string; qty: number }[] = [];
    const support: { itemId: string; qty: number }[] = [];
    for (const [k, v] of fd.entries()) {
      if (k.startsWith("t:")) tasks.push({ taskId: k.slice(2), qty: int(v) });
      if (k.startsWith("s:") && dec(v) > 0) support.push({ itemId: k.slice(2), qty: dec(v) });
    }
    const mode = str(fd, "mode") === "LANGSUNG" ? "LANGSUNG" : "DRIVER";
    const s = await createShipment({ date: str(fd, "date") || todayStr(), mode, pointIds: fd.getAll("pointId").map(String), driverId: optStr(fd, "driverId"), tasks, support, note: optStr(fd, "note") }, user, scope);
    const total = tasks.reduce((a, t) => a + t.qty, 0);
    return `Kiriman ${s.number} tercatat (${fmt(total)} pcs)`;
  },
  PATHS,
);

export const batalKiriman = action(
  [...PERMS],
  async (fd, user) => {
    await cancelShipment(str(fd, "id"), user, await boronganScope(prisma, user));
    return "Kiriman dibatalkan, bahan kembali ke gudang";
  },
  PATHS,
);

/** Isian a:<titik>:<pekerja>:<jenis> = jumlah dibagi */
export const simpanPembagian = action(
  [...PERMS],
  async (fd, user) => {
    const rows = [...fd.entries()].filter(([k]) => k.startsWith("a:")).map(([k, v]) => {
      const [, pointId, workerId, taskId] = k.split(":");
      return { pointId, workerId, taskId, qty: int(v) };
    });
    const r = await saveAllots(str(fd, "shipmentId"), rows, user, await boronganScope(prisma, user));
    return r.left > 0 ? `Pembagian ${r.number} tersimpan. Masih sisa ${fmt(r.left)} pcs belum dibagi.` : `Pembagian ${r.number} tersimpan, semua sudah dibagi`;
  },
  PATHS,
);

/** Isian g:<pekerja>:<jenis> = setoran bagus, r:<pekerja>:<jenis> = reject (kumulatif) */
export const laporHasil = action(
  [...PERMS],
  async (fd, user) => {
    const m = new Map<string, { workerId: string; taskId: string; good: number; reject: number }>();
    for (const [k, v] of fd.entries()) {
      if (!k.startsWith("g:") && !k.startsWith("r:")) continue;
      const [p, workerId, taskId] = k.split(":");
      const cur = m.get(`${workerId}:${taskId}`) ?? { workerId, taskId, good: 0, reject: 0 };
      if (p === "g") cur.good = int(v);
      else cur.reject = int(v);
      m.set(`${workerId}:${taskId}`, cur);
    }
    const rows = [...m.values()];
    await saveWorkReport(str(fd, "shipmentId"), str(fd, "pointId"), rows, fd.get("checked") === "on", user, await boronganScope(prisma, user));
    return `Laporan terkirim: setoran ${fmt(rows.reduce((a, r) => a + r.good, 0))}, reject ${fmt(rows.reduce((a, r) => a + r.reject, 0))}`;
  },
  PATHS,
);

/** Isian q:<titik>:<pekerja>:<jenis> = setoran bagus; d:<pekerja> = Selesai semua untuk pekerja itu */
export const ambilSetoran = action(
  [...PERMS],
  async (fd, user) => {
    const done = new Set([...fd.keys()].filter((k) => k.startsWith("d:")).map((k) => k.slice(2)));
    const rows = [...fd.entries()].filter(([k]) => k.startsWith("q:")).map(([k, v]) => {
      const [, pointId, workerId, taskId] = k.split(":");
      return { pointId, workerId, taskId, qty: int(v), done: done.has(workerId) };
    });
    const p = await createPickup(str(fd, "shipmentId"), rows, user, await boronganScope(prisma, user));
    return `Pengambilan ${p.number} tercatat (${fmt(rows.reduce((a, r) => a + r.qty, 0))} pcs), menunggu dihitung divisi`;
  },
  PATHS,
);

export const batalAmbil = action(
  [...PERMS],
  async (fd, user) => {
    await cancelPickup(str(fd, "id"), user, await boronganScope(prisma, user));
    return "Pengambilan dibatalkan";
  },
  PATHS,
);

/** Isian c:<jenis> = total dihitung divisi */
export const terimaSetoran = action(
  [...PERMS],
  async (fd, user) => {
    const counts = [...fd.entries()].filter(([k]) => k.startsWith("c:")).map(([k, v]) => ({ taskId: k.slice(2), qty: String(v).trim() === "" ? -1 : int(v) }));
    const empty = counts.find((c) => c.qty < 0);
    if (empty) throw new FieldError(`c:${empty.taskId}`, "Isi hitungan jenis ini (0 bila tidak ada)");
    const r = await receivePickup(str(fd, "pickupId"), counts, user, await boronganScope(prisma, user));
    // Setiap 7× setoran Assembling per titik, klaim upah dibuat otomatis
    if (!r.short) await autoClaims(r.pointIds);
    return r.short ? `${r.number} diterima dengan hitungan kurang. Upah ditahan, driver & Supervisor diberi notifikasi.` : `${r.number} cocok, barang masuk gudang`;
  },
  [...PATHS, "/gaji/borongan"],
);

/** Koreksi setoran driver (l:<baris>) atau lepas tahanan */
export const tindakTahanan = action(
  "borongan.manage",
  async (fd, user) => {
    const scope = await boronganScope(prisma, user);
    if (!scope.owner) throw new BoronganError("Koreksi / lepas tahanan setoran hanya oleh Owner");
    const lepas = str(fd, "mode") === "lepas";
    const lines = lepas ? undefined : [...fd.entries()].filter(([k]) => k.startsWith("l:")).map(([k, v]) => ({ id: k.slice(2), qty: Number(String(v).replace(/\./g, "")) }));
    const r = await resolvePickup(str(fd, "pickupId"), { reason: str(fd, "reason"), lines }, user, scope);
    if (!r.short) await autoClaims((await prisma.boronganPickupLine.findMany({ where: { pickupId: str(fd, "pickupId") }, select: { pointId: true } })).map((l) => l.pointId));
    return lepas ? `Tahanan ${r.number} dilepas` : r.short ? `Koreksi ${r.number} tersimpan, hitungan masih kurang (upah tetap ditahan)` : `Koreksi ${r.number} tersimpan, cocok dan upah dilepas`;
  },
  [...PATHS, "/gaji/borongan"],
);

// ---------------- KLAIM UPAH ----------------

export const klaimSekarang = action(
  [...PERMS],
  async (fd, user) => {
    const { requestClaim } = await import("@/lib/boronganClaim");
    const c = await requestClaim(str(fd, "pointId"), user, await boronganScope(prisma, user));
    return `Klaim ${c.number} diajukan (Rp${Number(c.total).toLocaleString("id-ID")}), menunggu persetujuan Finance / Owner`;
  },
  [...PATHS, "/borongan/klaim"],
);

export const setujuiKlaim = action(
  "borongan.pay",
  async (fd, user) => {
    const { approveClaim } = await import("@/lib/boronganClaim");
    const r = await approveClaim(str(fd, "id"), str(fd, "bankAccountId"), user);
    return `Klaim ${r.claim.number} disetujui & dibayar (${r.settlement.number}, Rp${Number(r.settlement.total).toLocaleString("id-ID")})`;
  },
  [...PATHS, "/borongan/klaim", "/akuntansi"],
);

export const tolakKlaim = action(
  "borongan.pay",
  async (fd, user) => {
    const { rejectClaim } = await import("@/lib/boronganClaim");
    const c = await rejectClaim(str(fd, "id"), str(fd, "reason"), user);
    return `Klaim ${c.number} ditolak, setorannya bisa diklaim lagi`;
  },
  [...PATHS, "/borongan/klaim"],
);

// ---------------- ASSEMBLING BERTAHAP ----------------

/** Tim Cetak/Oven: isian patung kering per jenis (t:<jenis>) */
export const isiPatungKering = action(
  [...PERMS],
  async (fd, user) => {
    const { createKeringDraft } = await import("@/lib/boronganFlow");
    const tasks = [...fd.entries()].filter(([k]) => k.startsWith("t:")).map(([k, v]) => ({ taskId: k.slice(2), qty: int(v) }));
    const s = await createKeringDraft({ date: str(fd, "date") || todayStr(), tasks, note: optStr(fd, "note") }, user, await boronganScope(prisma, user));
    return `Patung kering ${s.number} tercatat (${fmt(tasks.reduce((a, t) => a + t.qty, 0))} pcs), menunggu tim Assembling melengkapi bahan pendukung`;
  },
  PATHS,
);

/** Tim Assembling/Supervisor: lengkapi bahan pendukung (s:<barang>), titik, driver → kirim */
export const lengkapiKiriman = action(
  [...PERMS],
  async (fd, user) => {
    const { completeShipment } = await import("@/lib/boronganFlow");
    const support = [...fd.entries()].filter(([k, v]) => k.startsWith("s:") && dec(v) > 0).map(([k, v]) => ({ itemId: k.slice(2), qty: dec(v) }));
    const mode = str(fd, "mode") === "LANGSUNG" ? "LANGSUNG" : "DRIVER";
    const s = await completeShipment(str(fd, "shipmentId"), { date: str(fd, "date") || todayStr(), mode, pointIds: fd.getAll("pointId").map(String), driverId: optStr(fd, "driverId"), support, note: optStr(fd, "note") }, user, await boronganScope(prisma, user));
    return `Kiriman ${s.number} lengkap & dikirim`;
  },
  PATHS,
);
