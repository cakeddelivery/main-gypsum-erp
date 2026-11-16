import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { BoronganError, settleResultsTx, type Scope } from "./borongan";
import { taskGroupName } from "./boronganKirim";
import { isCoordinatorOf } from "./boronganFlow";
import { todayStr } from "./time";
import { sendPush } from "./push";
import { withField } from "./fieldError";

/**
 * KLAIM UPAH BORONGAN PER TITIK (keputusan Owner):
 *  - upah = setoran DITERIMA divisi × upah satuan; reject tidak dibayar dan tidak memotong upah;
 *  - klaim siap otomatis setiap 7× setoran Assembling (pengambilan AMB yang diterima) per titik. Cat Giftbox tidak
 *    dihitung untuk syarat 7×, tetapi upahnya ikut masuk klaim titik itu;
 *  - "Klaim Upah Sekarang" hanya untuk koordinator titik (titik tanpa koordinator, mis. Beringin: tim Assembling/Supervisor);
 *  - klaim disetujui & dibayar Finance atau Owner (izin borongan.pay); jurnal sama dengan Bayar Upah (fee driver = beban transport).
 * Upah yang ditahan (hitungan divisi kurang) tidak ikut klaim sampai dilepas.
 */
export const CLAIM_EVERY = 7;

type Tx = Prisma.TransactionClient;
type DB = Tx | typeof prisma;
type Actor = { id: string; name: string };

export const isAssemblingTask = (name: string) => /^assembling\b/i.test(name.trim());

/** Setoran yang siap diklaim di titik: diterima divisi, belum dibayar, tidak ditahan, belum masuk klaim */
const claimable = (pointId: string): Prisma.BoronganResultWhereInput => ({ pointId, settlementId: null, held: false, claimId: null });

/** Jumlah setoran Assembling (pengambilan AMB berbeda) yang belum diklaim di titik */
export async function assemblingCount(db: DB, pointId: string) {
  const rows = await db.boronganResult.findMany({ where: { ...claimable(pointId), pickupId: { not: null }, qty: { gt: 0 } }, select: { pickupId: true, task: { select: { name: true } } } });
  return new Set(rows.filter((r) => isAssemblingTask(r.task.name)).map((r) => r.pickupId)).size;
}

// ---------------- RINCIAN (murni) ----------------

type ResultLite = {
  qty: number; workerRate: bigint | number; coordinatorRate: bigint | number; driverRate: bigint | number;
  task: { name: string };
  worker: { id: string; name: string };
  coordinator: { id: string; name: string } | null;
  driver: { id: string; name: string } | null;
};
export type ClaimLine = { label: string; qty: number; rate: number; amount: number };
export type ClaimPerson = { id: string; name: string; lines: ClaimLine[]; total: number };
export type ClaimBreakdown = { workers: ClaimPerson[]; coordinators: ClaimPerson[]; drivers: ClaimPerson[]; totals: { workers: number; coordinators: number; drivers: number; all: number } };

function addLine(map: Map<string, ClaimPerson>, id: string, name: string, label: string, qty: number, rate: number) {
  const p = map.get(id) ?? { id, name, lines: [], total: 0 };
  const l = p.lines.find((x) => x.label === label && x.rate === rate);
  if (l) {
    l.qty += qty;
    l.amount += qty * rate;
  } else p.lines.push({ label, qty, rate, amount: qty * rate });
  p.total += qty * rate;
  map.set(id, p);
}

/**
 * Rincian klaim: Pekerja (per orang, per pekerjaan: jumlah × upah satuan), Koordinator (per kelompok pekerjaan),
 * Fee driver (per driver; selalu ada, Rp0 bila semua diantar langsung), lalu total.
 */
export function claimBreakdown(results: ResultLite[]): ClaimBreakdown {
  const workers = new Map<string, ClaimPerson>();
  const coords = new Map<string, ClaimPerson>();
  const drivers = new Map<string, ClaimPerson>();
  for (const r of results) {
    if (r.qty <= 0) continue;
    const group = taskGroupName(r.task.name);
    addLine(workers, r.worker.id, r.worker.name, r.task.name, r.qty, Number(r.workerRate));
    if (r.coordinator) addLine(coords, r.coordinator.id, r.coordinator.name, `${group} (semua pekerja)`, r.qty, Number(r.coordinatorRate));
    if (r.driver) addLine(drivers, r.driver.id, r.driver.name, `${group} (antar bahan & ambil setoran)`, r.qty, Number(r.driverRate));
    else addLine(drivers, "-", "Tanpa driver (diantar langsung)", group, r.qty, 0);
  }
  const sort = (m: Map<string, ClaimPerson>) => [...m.values()].sort((a, b) => a.name.localeCompare(b.name, "id"));
  const w = sort(workers);
  const c = sort(coords);
  const d = sort(drivers);
  const sum = (xs: ClaimPerson[]) => xs.reduce((a, x) => a + x.total, 0);
  return { workers: w, coordinators: c, drivers: d, totals: { workers: sum(w), coordinators: sum(c), drivers: sum(d), all: sum(w) + sum(c) + sum(d) } };
}

// ---------------- AKSES ----------------

/** Klaim Upah Sekarang: koordinator titik itu; titik tanpa koordinator → tim Assembling (divisi) atau Supervisor/pengelola */
export function canRequestClaim(scope: Scope, pointId: string, hasCoordinator: boolean) {
  if (hasCoordinator) return isCoordinatorOf(scope, pointId);
  return scope.all || (!!scope.division && !scope.driver && (!!scope.warehouse || scope.pointIds.includes(pointId)));
}

// ---------------- AJUKAN / OTOMATIS ----------------

async function claimNumber(tx: Tx, code: string, day: string) {
  const base = `KLM-${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}-${code}`;
  const used = await tx.boronganClaim.count({ where: { number: { startsWith: base } } });
  return used ? `${base}-${used + 1}` : base;
}

const resultInclude = { worker: { select: { id: true, name: true } }, coordinator: { select: { id: true, name: true } }, driver: { select: { id: true, name: true } }, task: { select: { name: true } } } as const;

async function createClaimTx(tx: Tx, pointId: string, actor: { id: string | null; name: string }, auto: boolean) {
  await tx.$queryRaw`SELECT id FROM "BoronganPoint" WHERE id = ${pointId} FOR UPDATE`;
  const point = await tx.boronganPoint.findUniqueOrThrow({ where: { id: pointId } });
  const results = await tx.boronganResult.findMany({ where: claimable(pointId), include: resultInclude });
  const b = claimBreakdown(results);
  if (!results.length || b.totals.all <= 0) throw new BoronganError(`Belum ada upah ${point.name} yang bisa diklaim`);
  const number = await claimNumber(tx, point.code, todayStr());
  const c = await tx.boronganClaim.create({ data: { number, pointId, auto, total: BigInt(b.totals.all), requestedBy: actor.name, requestedById: actor.id } });
  await tx.boronganResult.updateMany({ where: { id: { in: results.map((r) => r.id) } }, data: { claimId: c.id } });
  await audit(actor.id ? { id: actor.id, name: actor.name } : { actorName: actor.name }, "KLAIM_UPAH_BORONGAN", "BoronganClaim", c.id, { number, titik: point.code, total: b.totals.all, otomatis: auto || undefined }, tx);
  return { claim: c, point };
}

async function notifyApprovers(title: string, body: string, tag: string) {
  const users = await prisma.user.findMany({ where: { active: true, role: { in: ["OWNER", "FINANCE"] } }, select: { id: true } });
  if (users.length) await sendPush(users.map((u) => u.id), { title, body, url: "/borongan?tab=klaim", tag }).catch(() => {});
}

export async function requestClaim(pointId: string, actor: Actor, scope: Scope) {
  const hasCoordinator = (await prisma.boronganPerson.count({ where: { role: "KOORDINATOR", active: true, pointId } })) > 0;
  if (!canRequestClaim(scope, pointId, hasCoordinator)) throw new BoronganError(hasCoordinator ? "Klaim upah diajukan koordinator titik" : "Klaim upah titik ini diajukan tim Assembling / Supervisor");
  const { claim, point } = await prisma.$transaction((tx) => createClaimTx(tx, pointId, actor, false));
  await notifyApprovers(`Klaim upah ${point.name} menunggu`, `${claim.number} · Rp${Number(claim.total).toLocaleString("id-ID")}`, `klaim-${claim.id}`);
  return claim;
}

/** Dipanggil setelah setoran diterima: titik yang sudah 7× setoran Assembling langsung dibuatkan klaim */
export async function autoClaims(pointIds: string[]) {
  const made = [];
  for (const pointId of [...new Set(pointIds)]) {
    const r = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "BoronganPoint" WHERE id = ${pointId} FOR UPDATE`;
      if ((await assemblingCount(tx, pointId)) < CLAIM_EVERY) return null;
      return createClaimTx(tx, pointId, { id: null, name: `Sistem (${CLAIM_EVERY}× setoran)` }, true);
    });
    if (r) {
      made.push(r.claim);
      await notifyApprovers(`Klaim upah ${r.point.name} siap`, `${r.claim.number} otomatis setelah ${CLAIM_EVERY}× setoran · Rp${Number(r.claim.total).toLocaleString("id-ID")}`, `klaim-${r.claim.id}`);
    }
  }
  return made;
}

// ---------------- SETUJUI & BAYAR / TOLAK ----------------

/** Finance/Owner menyetujui & membayar klaim (sekali saja; dua permintaan bersamaan tidak membayar dobel) */
export async function approveClaim(id: string, bankAccountId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganClaim" WHERE id = ${id} FOR UPDATE`;
    const c = await tx.boronganClaim.findUniqueOrThrow({ where: { id }, include: { point: true } });
    if (c.status !== "MENUNGGU") throw new BoronganError(`${c.number} sudah ${c.status === "DIBAYAR" ? "dibayar" : "ditolak"}`);
    const results = await tx.boronganResult.findMany({ where: { claimId: id, settlementId: null }, include: { worker: true, coordinator: true, driver: true, task: true }, orderBy: { date: "asc" } });
    if (!results.length) throw new BoronganError("Klaim ini tidak berisi setoran yang belum dibayar");
    const upTo = results.reduce((a, r) => (r.date > a ? r.date : a), results[0].date);
    const st = await settleResultsTx(tx, { pointId: c.pointId, upTo, bankAccountId, results, label: `klaim ${c.number}` }, actor);
    await tx.boronganClaim.update({ where: { id }, data: { status: "DIBAYAR", settlementId: st.id, decidedBy: actor.name, decidedAt: new Date(), total: st.total } });
    await audit(actor, "KLAIM_UPAH_DIBAYAR", "BoronganClaim", id, { number: c.number, settlement: st.number, total: Number(st.total) }, tx);
    return { claim: c, settlement: st };
  });
}

export async function rejectClaim(id: string, reason: string, actor: Actor) {
  if (!reason?.trim()) throw withField(new BoronganError("Alasan penolakan wajib diisi"), "reason");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganClaim" WHERE id = ${id} FOR UPDATE`;
    const c = await tx.boronganClaim.findUniqueOrThrow({ where: { id } });
    if (c.status !== "MENUNGGU") throw new BoronganError(`${c.number} sudah diproses`);
    // Setorannya kembali bisa diklaim lagi setelah diperbaiki
    await tx.boronganResult.updateMany({ where: { claimId: id, settlementId: null }, data: { claimId: null } });
    await tx.boronganClaim.update({ where: { id }, data: { status: "DITOLAK", decidedBy: actor.name, decidedAt: new Date(), rejectReason: reason.trim().slice(0, 300) } });
    await audit(actor, "KLAIM_UPAH_DITOLAK", "BoronganClaim", id, { number: c.number, alasan: reason }, tx);
    return c;
  });
}

// ---------------- TAMPILAN ----------------

export async function claimDetail(id: string) {
  const c = await prisma.boronganClaim.findUnique({ where: { id }, include: { point: true, settlement: { select: { number: true, date: true } }, results: { include: resultInclude, orderBy: { date: "asc" } } } });
  if (!c) return null;
  const dates = c.results.map((r) => r.date.toISOString().slice(0, 10)).sort();
  return { ...c, breakdown: claimBreakdown(c.results), from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
}

/**
 * Rincian untuk satu pekerja saja (dokumen per pekerja): hanya fee pekerja itu; koordinator & driver tidak tampil.
 */
export function onlyWorker(b: ClaimBreakdown, workerId: string): ClaimBreakdown {
  const workers = b.workers.filter((w) => w.id === workerId);
  const t = workers.reduce((a, w) => a + w.total, 0);
  return { workers, coordinators: [], drivers: [], totals: { workers: t, coordinators: 0, drivers: 0, all: t } };
}

/** Ringkasan upah titik untuk HP koordinator: progres 7× dan upah belum diklaim */
export async function pointWageSummary(pointId: string) {
  const [count, results, claims] = await Promise.all([
    assemblingCount(prisma, pointId),
    prisma.boronganResult.findMany({ where: claimable(pointId), include: resultInclude }),
    prisma.boronganClaim.findMany({ where: { pointId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, number: true, status: true, total: true, createdAt: true, auto: true, rejectReason: true } }),
  ]);
  const held = await prisma.boronganResult.count({ where: { pointId, settlementId: null, held: true } });
  const dates = results.map((r) => r.date.toISOString().slice(0, 10)).sort();
  return { count, every: CLAIM_EVERY, breakdown: claimBreakdown(results), claims, held, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null, setoran: results.length };
}
