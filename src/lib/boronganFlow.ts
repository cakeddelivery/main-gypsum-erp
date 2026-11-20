import { Prisma, type PickupStatus, type ShipmentMode } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { addDays, dateOnly, dateStr, todayStr } from "./time";
import { recordMovement, reverseMovementsByRef } from "./stock";
import { bomStockQty } from "./unitcost";
import { BoronganError, canTask, coordinatorCovers, coordinatorFor, coordinatorPointSelect, coordinatorsAt, postResultTx, unpostResultTx, warehouseFor, type Scope } from "./borongan";
import { taskGroupName } from "./boronganKirim";
import { pointConfig, taskKits } from "./boronganSetup";
import { sendPush, type PushPayload } from "./push";
import { withField } from "./fieldError";

/**
 * ALUR BORONGAN BARU (menggantikan serah terima KIRIM → konfirmasi titik → KEMBALI yang sering terlewat):
 *  1. Kirim bahan (Supervisor / Kapten Assembling): kiriman bernomor KRM-DDMMYY-NN, jumlah pekerjaan per jenis + bahan.
 *     Lewat driver: bahan gudang → lokasi DRIVER (bahan ada di mobil); diantar langsung: gudang → lokasi titik.
 *  2. Pembagian ke pekerja (driver; kiriman langsung oleh tim divisi/Supervisor): jumlah per pekerja per jenis.
 *     Lewat driver, bahan pindah dari lokasi driver ke lokasi titik sesuai yang dibagi (jejak stok per titik tetap ada).
 *  3. Lapor hasil (koordinator titik; titik tanpa koordinator oleh tim divisi/Supervisor): setoran bagus & reject per
 *     pekerja, kumulatif, boleh berkali-kali. Reject HANYA dicatat di sini.
 *  4. Ambil setoran (driver / tim): AMB-DDMMYY-NN, setoran bagus per pekerja; "Selesai semua" menutup sel itu.
 *  5. Terima setoran (divisi penerima): total per jenis. Cocok → barang masuk gudang & upah = setoran driver.
 *     Kurang → upah pengambilan itu DITAHAN (tidak ikut dibayar) dan driver + Supervisor diberi notifikasi.
 * Upah, stok bahan, dan jurnal memakai postResultTx (sama dengan setoran alur lama), jadi pembayaran upah tetap satu jalur.
 */

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

// ---------------- NOMOR ----------------

/** Nomor harian: KRM-151126-01 (prefix-DDMMYY-urut per hari) */
export async function dailyNumber(tx: Tx, prefix: string, day: string): Promise<string> {
  const d = `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}`;
  const key = `${prefix}-${d}`;
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "Counter"("key","value") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = "Counter"."value" + 1
    RETURNING "value"`;
  return `${key}-${String(rows[0].value).padStart(2, "0")}`;
}

// ---------------- HITUNGAN (murni, diuji unit) ----------------

/** Nama kolom pendek: "Assembling Cowok" → "Cowok", "Cat plastik merah" → "Merah", "Cat giftbox" → "Cat Giftbox" */
export function shortTaskName(name: string) {
  const g = taskGroupName(name);
  const rest = name.trim().slice(g.length).trim().replace(/^transportasi$/i, "Transport");
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : g;
}

/** Urutan kolom seperti di lapangan: Cowok, Cewek, Hewan, Transport; Merah, Biru, Kuning */
const COLUMN_ORDER = ["cowok", "cewek", "hewan", "transport", "merah", "biru", "kuning"];
export function byColumn<T>(xs: T[], name: (x: T) => string): T[] {
  const rank = (x: T) => {
    const i = COLUMN_ORDER.indexOf(shortTaskName(name(x)).toLowerCase());
    return i < 0 ? COLUMN_ORDER.length : i;
  };
  return [...xs].sort((a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b), "id"));
}

/** Sisa di pekerja (sebelum "Selesai semua") / selisih (sesudahnya): dibagi − diambil − setoran − reject */
export const remain = (c: { dibagi: number; diambil: number; setoran: number; reject: number }) => c.dibagi - c.diambil - c.setoran - c.reject;

/** "Selesai semua": setoran otomatis = dibagi − diambil − reject (tidak minus), masih bisa diubah */
export const autofill = (c: { dibagi: number; diambil: number; reject: number }) => Math.max(0, c.dibagi - c.diambil - c.reject);

/** Reject laporan koordinator yang belum dibukukan (laporan kumulatif; reject yang sudah dibukukan tidak dihitung lagi) */
export const rejectToAccount = (latest: number, accounted: number) => Math.max(0, latest - accounted);

/**
 * Bagi `total` ke beberapa kunci menurut bobot dengan pembulatan sisa terbesar (jumlahnya tepat `total`).
 * decimals 0 = bilangan bulat, 3 = sampai 0,001.
 */
export function splitByWeights<K>(total: number, weights: [K, number][], decimals = 0): Map<K, number> {
  const out = new Map<K, number>();
  const sum = weights.reduce((a, [, w]) => a + Math.max(0, w), 0);
  if (sum <= 0 || total <= 0) return out;
  const scale = 10 ** decimals;
  const units = Math.round(total * scale);
  const raw = weights.map(([k, w]) => ({ k, exact: (units * Math.max(0, w)) / sum }));
  let given = 0;
  const base = raw.map((r) => ({ ...r, n: Math.floor(r.exact + 1e-9) }));
  for (const b of base) given += b.n;
  const order = [...base].sort((a, b) => b.exact - b.n - (a.exact - a.n));
  for (let i = 0; i < units - given; i++) order[i % order.length].n += 1;
  for (const b of base) if (b.n > 0) out.set(b.k, b.n / scale);
  return out;
}

export type CountRow = { taskId: string; driver: number; counted: number; diff: number };
/** Hitungan divisi vs setoran driver per jenis; kurang = ada jenis yang dihitung lebih sedikit */
export function checkCounts(driver: Map<string, number>, counted: Map<string, number>): { rows: CountRow[]; short: boolean } {
  const ids = [...new Set([...driver.keys(), ...counted.keys()])];
  const rows = ids.map((taskId) => {
    const d = driver.get(taskId) ?? 0;
    const c = counted.get(taskId) ?? 0;
    return { taskId, driver: d, counted: c, diff: c - d };
  });
  return { rows, short: rows.some((r) => r.diff < 0) };
}

export type ShipmentState = "DI_PEKERJA" | "SEBAGIAN" | "SELESAI";
export const STATE_LABEL: Record<ShipmentState, string> = { DI_PEKERJA: "Di pekerja", SEBAGIAN: "Sebagian", SELESAI: "Selesai" };

/** Belum ada pengambilan = di pekerja; semua sel yang dibagi sudah "Selesai semua" = selesai; selain itu sebagian */
export function shipmentState(allots: { workerId: string; taskId: string; qty: number }[], pickups: { status: PickupStatus; lines: { workerId: string; taskId: string; done: boolean }[] }[]): ShipmentState {
  const active = pickups.filter((p) => p.status !== "DIBATALKAN");
  if (!active.length) return "DI_PEKERJA";
  const done = new Set(active.flatMap((p) => p.lines.filter((l) => l.done).map((l) => `${l.workerId}:${l.taskId}`)));
  const cells = allots.filter((a) => a.qty > 0);
  return cells.length && cells.every((a) => done.has(`${a.workerId}:${a.taskId}`)) ? "SELESAI" : "SEBAGIAN";
}

// ---------------- AKSES ----------------

/** Pekerjaan Assembling (patung): diawali isian patung kering Cetak/Oven, dilengkapi Assembling/Supervisor */
export const isAssemblingName = (name: string) => /^assembling\b/i.test(name.trim());
/** Boleh mencatat kiriman (Cat Plastik: tim Assembling; Cat Giftbox: tim Giftbox; Supervisor/pengelola: semua) */
export const canShip = (scope: Scope) => scope.all || scope.division?.template === "ASSEMBLING" || scope.division?.template === "GIFTBOX" || !!scope.warehouse;
/** Kelompok pekerjaan yang boleh dikirim langsung oleh akun ini (Assembling selalu lewat isian patung kering) */
export function canShipGroup(scope: Scope, groupName: string) {
  if (isAssemblingName(groupName)) return false;
  if (scope.all) return true;
  const t = scope.division?.template;
  if (/^cat plastik/i.test(groupName)) return t === "ASSEMBLING" || !!scope.warehouse;
  if (/^cat giftbox/i.test(groupName)) return t === "GIFTBOX";
  return !!scope.warehouse;
}
/** Isi patung kering kiriman Assembling: tim Cetak/Oven atau Supervisor/pengelola */
export const canInputKering = (scope: Scope) => scope.all || !!scope.kering;
/** Lengkapi bahan pendukung, titik, driver kiriman Assembling: tim Assembling atau Supervisor/pengelola */
export const canCompleteAssembling = (scope: Scope) => scope.all || scope.division?.template === "ASSEMBLING" || !!scope.warehouse;
/** Tim divisi (Assembling / Giftbox) yang mencatat semua jenis pekerjaan kiriman ini */
const divisionCovers = (scope: Scope, taskIds: string[]) => !!scope.division && !scope.driver && taskIds.every((id) => canTask(scope, id));
/** Akses penuh semua aksi kiriman: Owner dan Supervisor (backup, atas nama peran aslinya) */
export const fullAccess = (scope: Scope) => !!scope.owner || !!scope.backup;
/** Pembagian & ambil setoran: lewat driver = driver; diantar langsung = tim divisi; Owner selalu boleh (Supervisor hanya memantau) */
export const canDistribute = (scope: Scope, s: { mode: ShipmentMode; taskIds: string[] }) => fullAccess(scope) || (s.mode === "DRIVER" ? !!scope.driver : divisionCovers(scope, s.taskIds));
export const canPickup = canDistribute;
export const isCoordinatorOf = (scope: Scope, pointId: string) => !scope.all && !scope.driver && !scope.division && !!scope.personId && scope.pointIds.includes(pointId);
/**
 * Lapor hasil: koordinator titik; titik tanpa koordinator oleh tim divisi; Owner selalu boleh.
 * `coordinatorOnly` = titik punya koordinator yang menerima fee: hanya koordinator itu yang mencatat. Titik tanpa fee
 * koordinator (mis. Beringin dengan pencatat Mita): koordinator pencatat DAN tim divisi (cadangan) boleh mencatat.
 */
export const canReport = (scope: Scope, s: { taskIds: string[] }, pointId: string, coordinatorOnly: boolean) => fullAccess(scope) || isCoordinatorOf(scope, pointId) || (!coordinatorOnly && divisionCovers(scope, s.taskIds));

/** Lapor hasil hanya oleh koordinator: titik punya koordinator aktif DAN bukan titik tanpa fee koordinator (pencatat saja) */
export async function coordinatorOnly(db: Tx | typeof prisma, pointId: string) {
  const [n, point] = await Promise.all([
    db.boronganPerson.count({ where: coordinatorsAt(pointId) }),
    db.boronganPoint.findUnique({ where: { id: pointId }, select: { noCoordinator: true } }),
  ]);
  return n > 0 && !point?.noCoordinator;
}
/**
 * Terima setoran: patung Assembling diterima tim PACKING; pekerjaan lain oleh divisi tugasnya (Cat Plastik: Assembling,
 * Cat Giftbox: Giftbox); Owner selalu boleh.
 */
export const canReceive = (scope: Scope, tasks: { name: string; divisionId: string | null }[]) =>
  fullAccess(scope) || (!!scope.division && !scope.driver && tasks.every((t) => (isAssemblingName(t.name) ? !!scope.packing : t.divisionId === scope.division!.id)));

/**
 * Batalkan kiriman: Owner kapan saja (sebelum ada pengambilan); pencatatnya selama belum dibagi ke pekerja.
 * Isian patung kering yang belum dilengkapi: juga tim Assembling. Supervisor lain hanya memantau.
 */
export function canCancelShipment(scope: Scope, s: { waitingSupport: boolean; createdById: string | null; _count?: { allots: number } }, userId: string) {
  if (fullAccess(scope)) return true;
  if (s.waitingSupport) return (canCompleteAssembling(scope) && !scope.all) || s.createdById === userId;
  return s.createdById === userId && (s._count?.allots ?? 0) === 0;
}

// ---------------- DATA ----------------

const shipmentInclude = {
  tasks: { include: { task: { select: { id: true, name: true, divisionId: true } } } },
  lines: true,
  allots: { include: { worker: { select: { id: true, name: true } } } },
  reports: { include: { lines: true }, orderBy: { createdAt: "desc" as const } },
  pickups: { include: { lines: { include: { worker: { select: { id: true, name: true } } } }, counts: true, driver: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" as const } },
  driver: { select: { id: true, name: true } },
} satisfies Prisma.BoronganShipmentInclude;
type ShipmentRow = Prisma.BoronganShipmentGetPayload<{ include: typeof shipmentInclude }>;

export type CellView = { pointId: string; workerId: string; worker: string; taskId: string; dibagi: number; diambil: number; good: number; reject: number; reported: boolean; done: boolean };
export type PickupView = { id: string; number: string; date: string; status: PickupStatus; driver: string | null; holdNote: string | null; lines: { id: string; pointId: string; workerId: string; worker: string; taskId: string; qty: number; reject: number; done: boolean }[]; counts: { taskId: string; qty: number }[] };
export type ShipmentView = {
  id: string; number: string; date: string; mode: ShipmentMode; driver: string | null; state: ShipmentState; note: string | null; createdBy: string; cancelled: boolean; waitingSupport: boolean;
  /** Ditutup administratif (tanpa stok/upah): catatan penutupan, null = tidak */
  closed?: string | null;
  group: string;
  /** coordinator = ada koordinator aktif; coordinatorOnly = lapor hasil hanya oleh koordinator (bukan titik tanpa fee koordinator) */
  points: { id: string; name: string; coordinator: boolean; coordinatorOnly?: boolean }[];
  tasks: { id: string; name: string; short: string; qty: number; divisionId: string | null }[];
  lines: { itemId: string; name: string; unit: string; qty: number; support: boolean }[];
  cells: CellView[];
  pickups: PickupView[];
  reports: { pointId: string; at: string; by: string; checked: boolean }[];
  totals: { sent: number; allotted: number; received: number; reject: number; atWorkers: number; gap: number | null };
};

/** Laporan terakhir per titik (kumulatif) */
function latestReports(s: ShipmentRow) {
  const m = new Map<string, ShipmentRow["reports"][number]>();
  for (const r of s.reports) if (!m.has(r.pointId)) m.set(r.pointId, r);
  return m;
}

export async function buildViews(rows: ShipmentRow[]): Promise<ShipmentView[]> {
  const pointIds = [...new Set(rows.flatMap((s) => s.pointIds))];
  const itemIds = [...new Set(rows.flatMap((s) => s.lines.map((l) => l.itemId)))];
  const [points, coords, items] = await Promise.all([
    prisma.boronganPoint.findMany({ where: { id: { in: pointIds } }, select: { id: true, name: true, code: true, noCoordinator: true } }),
    prisma.boronganPerson.findMany({ where: coordinatorsAt(pointIds), select: coordinatorPointSelect }),
    prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, unit: true } }),
  ]);
  return rows.map((s) => {
    const active = s.pickups.filter((p) => p.status !== "DIBATALKAN");
    const reps = latestReports(s);
    const cells: CellView[] = s.allots.map((a) => {
      const rep = reps.get(a.pointId)?.lines.find((l) => l.workerId === a.workerId && l.taskId === a.taskId);
      const mine = active.flatMap((p) => p.lines.filter((l) => l.workerId === a.workerId && l.taskId === a.taskId));
      return { pointId: a.pointId, workerId: a.workerId, worker: a.worker.name, taskId: a.taskId, dibagi: a.qty, diambil: mine.reduce((x, l) => x + l.qty, 0), good: rep?.good ?? 0, reject: rep?.reject ?? 0, reported: !!rep, done: mine.some((l) => l.done) };
    });
    // Ditutup administratif (npm run borongan:tutup-semua) = selesai walau ada sel belum "Selesai semua"
    const state = s.closedAt ? "SELESAI" : shipmentState(s.allots, s.pickups);
    const sent = s.tasks.reduce((a, t) => a + t.qty, 0);
    const received = active.filter((p) => p.status !== "DIBAWA").reduce((a, p) => a + p.lines.reduce((x, l) => x + l.qty, 0), 0);
    const reject = cells.reduce((a, c) => a + c.reject, 0);
    const taken = cells.reduce((a, c) => a + c.diambil, 0);
    return {
      id: s.id, number: s.number, date: dateStr(s.date), mode: s.mode, driver: s.driver?.name ?? null, state, note: s.note, createdBy: s.createdBy, cancelled: !!s.cancelledAt, waitingSupport: s.waitingSupport,
      closed: s.closedAt ? `${s.closeNote ?? "Ditutup administratif"} (${s.closedBy ?? "-"}, ${dateStr(s.closedAt)})` : null,
      group: s.tasks[0] ? taskGroupName(s.tasks[0].task.name) : "",
      points: s.pointIds.map((id) => {
        const coordinator = coords.some((c) => coordinatorCovers(c, id));
        return { id, name: points.find((p) => p.id === id)?.name ?? "?", coordinator, coordinatorOnly: coordinator && !points.find((p) => p.id === id)?.noCoordinator };
      }),
      tasks: byColumn(s.tasks, (t) => t.task.name).map((t) => ({ id: t.taskId, name: t.task.name, short: shortTaskName(t.task.name), qty: t.qty, divisionId: t.task.divisionId })),
      lines: s.lines.map((l) => ({ itemId: l.itemId, name: items.find((i) => i.id === l.itemId)?.name ?? "?", unit: items.find((i) => i.id === l.itemId)?.unit ?? "", qty: Number(l.qty), support: l.support })),
      cells,
      pickups: s.pickups.map((p) => ({
        id: p.id, number: p.number, date: dateStr(p.date), status: p.status, driver: p.driver?.name ?? null, holdNote: p.holdNote,
        lines: p.lines.map((l) => ({ id: l.id, pointId: l.pointId, workerId: l.workerId, worker: l.worker.name, taskId: l.taskId, qty: l.qty, reject: l.reject, done: l.done })),
        counts: p.counts.map((c) => ({ taskId: c.taskId, qty: c.qty })),
      })),
      reports: [...reps.values()].map((r) => ({ pointId: r.pointId, at: r.createdAt.toISOString(), by: r.createdBy, checked: r.checked })),
      totals: { sent, allotted: s.allots.reduce((a, x) => a + x.qty, 0), received, reject, atWorkers: Math.max(0, sent - taken - reject), gap: state === "SELESAI" ? sent - taken - reject : null },
    };
  });
}

export async function shipmentViews(where: Prisma.BoronganShipmentWhereInput, take = 100) {
  const rows = await prisma.boronganShipment.findMany({ where, include: shipmentInclude, orderBy: [{ date: "desc" }, { number: "desc" }], take });
  return buildViews(rows);
}

export async function shipmentView(id: string) {
  const s = await prisma.boronganShipment.findUnique({ where: { id }, include: shipmentInclude });
  return s ? (await buildViews([s]))[0] : null;
}

/** Kiriman yang masih berjalan (belum selesai semua) dalam 120 hari terakhir */
export async function openShipments(now = new Date()) {
  const list = await shipmentViews({ cancelledAt: null, date: { gte: dateOnly(addDays(todayStr(now), -120)) } }, 200);
  return list.filter((s) => s.state !== "SELESAI" || s.pickups.some((p) => p.status === "DIBAWA" || p.status === "KURANG"));
}

/** Akun koordinator titik (bukan pengelola, driver, atau tim divisi) */
export const isCoordinatorScope = (scope: Scope) => !scope.all && !scope.driver && !scope.division && !!scope.personId;

/**
 * Tampilan kiriman untuk koordinator: HANYA titiknya sendiri. Kiriman baru tampil setelah driver membagi bahan
 * ke pekerja di titik itu (null bila belum ada pembagian). Angka = bagian titik itu saja; nama titik lain,
 * bahan kiriman total, dan hitungan divisi yang mencakup titik lain dibuang di server.
 */
export function forCoordinator(v: ShipmentView, pointIds: string[]): ShipmentView | null {
  const own = (id: string) => pointIds.includes(id);
  const cells = v.cells.filter((c) => own(c.pointId) && c.dibagi > 0);
  if (!cells.length) return null;
  const taskIds = new Set(cells.map((c) => c.taskId));
  const pickups = v.pickups
    .map((p) => ({ ...p, lines: p.lines.filter((l) => own(l.pointId)), counts: p.lines.every((l) => own(l.pointId)) ? p.counts : [] }))
    .filter((p) => p.lines.length);
  const active = pickups.filter((p) => p.status !== "DIBATALKAN");
  const sent = cells.reduce((a, c) => a + c.dibagi, 0);
  const taken = cells.reduce((a, c) => a + c.diambil, 0);
  const reject = cells.reduce((a, c) => a + c.reject, 0);
  const received = active.filter((p) => p.status !== "DIBAWA").reduce((a, p) => a + p.lines.reduce((x, l) => x + l.qty, 0), 0);
  const state = v.closed ? "SELESAI" : shipmentState(cells.map((c) => ({ workerId: c.workerId, taskId: c.taskId, qty: c.dibagi })), active);
  return {
    ...v,
    state,
    points: v.points.filter((p) => own(p.id)),
    tasks: v.tasks.filter((t) => taskIds.has(t.id)).map((t) => ({ ...t, qty: cells.filter((c) => c.taskId === t.id).reduce((a, c) => a + c.dibagi, 0) })),
    lines: [],
    cells,
    pickups,
    reports: v.reports.filter((r) => own(r.pointId)),
    totals: { sent, allotted: sent, received, reject, atWorkers: Math.max(0, sent - taken - reject), gap: state === "SELESAI" ? sent - taken - reject : null },
  };
}

/** Saring daftar kiriman menurut akses: koordinator hanya bagian titiknya, lainnya apa adanya */
export function scopeShipments(scope: Scope, list: ShipmentView[]): ShipmentView[] {
  if (!isCoordinatorScope(scope)) return list;
  return list.map((v) => forCoordinator(v, scope.pointIds)).filter((v): v is ShipmentView => !!v);
}

// ---------------- 1. KIRIM BAHAN ----------------

async function driverLocation(tx: Tx) {
  const s = await tx.setting.findUnique({ where: { key: "loc_borongan_driver" } });
  if (s) return s.value;
  const l = await tx.location.findUnique({ where: { code: "DRV" } });
  if (!l) throw new BoronganError("Lokasi driver borongan belum ada");
  return l.id;
}

export type ShipmentInput = { date: string; mode: ShipmentMode; pointIds: string[]; driverId?: string | null; tasks: { taskId: string; qty: number }[]; support?: { itemId: string; qty: number }[]; note?: string | null };

type TaskWithInputs = Prisma.PieceTaskGetPayload<{ include: { inputs: { include: { item: true } } } }>;

function cleanTasks(list: { taskId: string; qty: number }[]) {
  const tasksIn = list.filter((t) => t.qty > 0);
  if (tasksIn.some((t) => !Number.isInteger(t.qty))) throw new BoronganError("Jumlah per jenis harus bilangan bulat");
  if (!tasksIn.length) throw withField(new BoronganError("Isi jumlah minimal satu jenis pekerjaan"), "t");
  return tasksIn;
}

async function loadTasks(tx: Tx, tasksIn: { taskId: string }[]) {
  const tasks = await tx.pieceTask.findMany({ where: { id: { in: tasksIn.map((t) => t.taskId) } }, include: { inputs: { include: { item: true } } } });
  if (tasks.length !== tasksIn.length || tasks.some((t) => !t.active)) throw new BoronganError("Ada jenis pekerjaan yang tidak aktif. Muat ulang halaman.");
  if (new Set(tasks.map((t) => taskGroupName(t.name))).size > 1) throw new BoronganError("Satu kiriman untuk satu jenis pekerjaan (mis. Assembling saja)");
  return tasks;
}

/**
 * Titik, driver, bahan resep + bahan pendukung (kit tugas), lalu stok keluar gudang → mobil driver / titik.
 * Dipakai kirim langsung (Cat Plastik, Cat Giftbox) dan saat kiriman Assembling dilengkapi.
 */
async function dispatchTx(tx: Tx, number: string, day: string, input: Omit<ShipmentInput, "tasks" | "date">, tasks: TaskWithInputs[], tasksIn: { taskId: string; qty: number }[], actor: Actor) {
  const pointIds = [...new Set(input.pointIds.filter(Boolean))];
  if (!pointIds.length) throw withField(new BoronganError("Pilih titik tujuan"), "pointId");
  if (input.mode === "LANGSUNG" && pointIds.length !== 1) throw new BoronganError("Kiriman yang diantar langsung hanya ke satu titik");
  const points = await tx.boronganPoint.findMany({ where: { id: { in: pointIds }, active: true } });
  if (points.length !== pointIds.length) throw new BoronganError("Titik tujuan tidak aktif");
  const cfg = await pointConfig(tx);
  for (const p of points) if (cfg[p.id]?.tasks.length && !tasks.some((t) => cfg[p.id].tasks.includes(t.id))) throw new BoronganError(`Titik ${p.name} tidak mengerjakan ${taskGroupName(tasks[0].name)}`);
  let driverId: string | null = null;
  if (input.mode === "DRIVER") {
    const drivers = await tx.boronganPerson.findMany({ where: { role: "DRIVER", active: true }, select: { id: true } });
    if (drivers.length && !input.driverId) throw withField(new BoronganError("Pilih driver"), "driverId");
    if (input.driverId && !drivers.some((d) => d.id === input.driverId)) throw new BoronganError("Driver tidak aktif");
    driverId = input.driverId ?? null;
  }
  // Bahan resep (otomatis dari jumlah per jenis) + bahan pendukung
  const qty = new Map<string, { qty: number; support: boolean }>();
  const add = (itemId: string, q: number, support: boolean) => {
    if (!(q > 0)) return;
    const cur = qty.get(itemId) ?? { qty: 0, support };
    qty.set(itemId, { qty: Math.round((cur.qty + q) * 1000) / 1000, support: cur.support && support });
  };
  for (const t of tasks) for (const inp of t.inputs) add(inp.itemId, bomStockQty(inp.qty, inp.item) * tasksIn.find((x) => x.taskId === t.id)!.qty, false);
  // Bahan pendukung hanya dari kit tugas yang dikirim (mis. Assembling tidak membawa cat Cat Giftbox)
  const kit = new Set(Object.entries(await taskKits(tx)).filter(([id]) => tasks.some((t) => t.id === id)).flatMap(([, ids]) => ids));
  for (const s of input.support ?? []) {
    if (s.qty < 0) throw new BoronganError("Jumlah bahan tidak boleh minus");
    if (s.qty > 0 && !kit.has(s.itemId)) throw new BoronganError("Ada bahan pendukung yang bukan kit jenis pekerjaan ini. Muat ulang halaman.");
    add(s.itemId, s.qty, true);
  }
  const items = await tx.item.findMany({ where: { id: { in: [...qty.keys()] } } });
  const to = input.mode === "DRIVER" ? await driverLocation(tx) : points[0].locationId;
  const rows: Prisma.BoronganShipmentLineCreateWithoutShipmentInput[] = [];
  for (const [itemId, l] of qty) {
    const item = items.find((i) => i.id === itemId);
    if (!item) throw new BoronganError("Bahan tidak ditemukan");
    const warehouseId = await warehouseFor(tx, item.type);
    await recordMovement(tx, { type: "TRANSFER", itemId, qty: l.qty, fromLocationId: warehouseId, toLocationId: to, ref: `KRM:${number}`, note: `Kiriman ${number} ${input.mode === "DRIVER" ? "naik ke mobil driver" : `diantar ke ${points[0].name}`}`, date: new Date(`${day}T05:00:00.000Z`) }, actor);
    rows.push({ itemId, warehouseId, qty: new Prisma.Decimal(l.qty), support: l.support });
  }
  return { pointIds, driverId, rows, points };
}

async function notifyDispatched(s: { number: string; driverId: string | null; mode: ShipmentMode; pointIds: string[] }, total: number) {
  // Push ke HP driver (bila lewat driver) atau koordinator bila diantar langsung. Kiriman lewat driver baru
  // diberitahukan ke koordinator saat driver menyimpan pembagian di titiknya (lihat saveAllots).
  const driverUser = s.driverId ? (await prisma.boronganPerson.findUnique({ where: { id: s.driverId }, select: { userId: true } }))?.userId : null;
  // Koordinator yang baru minta bahan (7 hari terakhir): permintaannya dijawab dengan kiriman ini
  const asked = await prisma.auditLog.findMany({ where: { action: "MINTA_BAHAN_TITIK", entityId: { in: s.pointIds }, at: { gte: new Date(Date.now() - 7 * 86400000) } }, select: { entityId: true } });
  const askedPoints = [...new Set(asked.map((a) => a.entityId!).filter(Boolean))];
  if (askedPoints.length) await notify(await coordinatorUsers(askedPoints), { title: `Permintaan bahan dijawab`, body: `Kiriman ${s.number} sedang disiapkan untuk titik Anda (${total.toLocaleString("id-ID")} pcs). Pembagian ke pekerja menyusul.`, url: "/borongan?tab=stok", tag: `minta-${s.number}` });
  await notify(s.mode === "DRIVER" ? [driverUser] : [], { title: `Kiriman bahan ${s.number}`, body: `${total.toLocaleString("id-ID")} pcs ${s.mode === "DRIVER" ? "dibawa driver" : "diantar langsung"}. Pembagian ke pekerja menyusul.`, url: "/borongan?tab=kiriman", tag: `krm-${s.number}` });
}

/** Kirim langsung (Cat Plastik oleh tim Assembling, Cat Giftbox oleh tim Giftbox, atau Supervisor/pengelola) */
export async function createShipment(input: ShipmentInput, actor: Actor, scope: Scope) {
  if (!canShip(scope)) throw new BoronganError("Kiriman bahan dicatat Supervisor / tim divisi pengirim");
  const tasksIn = cleanTasks(input.tasks);
  const s = await prisma.$transaction(async (tx) => {
    const tasks = await loadTasks(tx, tasksIn);
    const group = taskGroupName(tasks[0].name);
    if (tasks.some((t) => isAssemblingName(t.name))) throw new BoronganError("Kiriman Assembling diawali isian patung kering oleh Cetak/Oven, lalu dilengkapi Assembling/Supervisor");
    if (!canShipGroup(scope, group)) throw new BoronganError(/^cat plastik/i.test(group) ? "Kiriman Cat Plastik dicatat tim Assembling / Supervisor" : /^cat giftbox/i.test(group) ? "Kiriman Cat Giftbox dicatat tim Giftbox / Supervisor" : "Kiriman bahan dicatat Supervisor");
    const number = await dailyNumber(tx, "KRM", input.date);
    const d = await dispatchTx(tx, number, input.date, input, tasks, tasksIn, actor);
    const s = await tx.boronganShipment.create({
      data: { number, date: dateOnly(input.date), mode: input.mode, pointIds: d.pointIds, driverId: d.driverId, note: input.note ?? null, createdBy: actor.name, createdById: actor.id, tasks: { create: tasksIn.map((t) => ({ taskId: t.taskId, qty: t.qty })) }, lines: { create: d.rows } },
    });
    await audit(actor, "KIRIMAN_BORONGAN", "BoronganShipment", s.id, { number, mode: input.mode, titik: d.points.map((p) => p.code), jenis: tasksIn }, tx);
    return s;
  }, { timeout: 30000 });
  await notifyDispatched(s, tasksIn.reduce((a, t) => a + t.qty, 0));
  return s;
}

/** Langkah 1 Assembling: tim Cetak/Oven mengisi patung kering per jenis. Stok belum keluar sampai dilengkapi. */
export async function createKeringDraft(input: { date: string; tasks: { taskId: string; qty: number }[]; note?: string | null }, actor: Actor, scope: Scope) {
  if (!canInputKering(scope)) throw new BoronganError("Patung kering diisi tim Cetak / Oven");
  const tasksIn = cleanTasks(input.tasks);
  const s = await prisma.$transaction(async (tx) => {
    const tasks = await loadTasks(tx, tasksIn);
    if (!tasks.every((t) => isAssemblingName(t.name))) throw new BoronganError("Isian patung kering hanya untuk pekerjaan Assembling");
    const number = await dailyNumber(tx, "KRM", input.date);
    const s = await tx.boronganShipment.create({
      data: { number, date: dateOnly(input.date), mode: "DRIVER", pointIds: [], waitingSupport: true, note: input.note ?? null, createdBy: actor.name, createdById: actor.id, tasks: { create: tasksIn.map((t) => ({ taskId: t.taskId, qty: t.qty })) } },
    });
    await audit(actor, "PATUNG_KERING_DIISI", "BoronganShipment", s.id, { number, jenis: tasksIn }, tx);
    return s;
  });
  // Beri tahu tim Assembling & Supervisor: lengkapi bahan pendukung
  const users = await prisma.user.findMany({ where: { active: true, OR: [{ role: "SUPERVISOR" }, { role: { in: ["KAPTEN_DIVISI", "OPERATOR"] }, OR: [{ division: { reportTemplate: "ASSEMBLING" } }, { employee: { division: { reportTemplate: "ASSEMBLING" } } }] }] }, select: { id: true } });
  await notify(users.map((u) => u.id), { title: `Patung kering ${s.number} siap`, body: `${tasksIn.reduce((a, t) => a + t.qty, 0).toLocaleString("id-ID")} pcs dari ${actor.name}. Lengkapi bahan pendukung, titik & driver.`, url: "/borongan?tab=kiriman", tag: `krm-${s.number}` });
  return s;
}

/** Langkah 2 Assembling: tim Assembling/Supervisor melengkapi bahan pendukung, titik, driver → stok keluar gudang */
export async function completeShipment(id: string, input: Omit<ShipmentInput, "tasks" | "date"> & { date?: string }, actor: Actor, scope: Scope) {
  if (!canCompleteAssembling(scope)) throw new BoronganError("Bahan pendukung dilengkapi tim Assembling / Supervisor");
  const s = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganShipment" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.boronganShipment.findUniqueOrThrow({ where: { id }, include: { tasks: true } });
    if (cur.cancelledAt) throw new BoronganError(`${cur.number} sudah dibatalkan`);
    if (!cur.waitingSupport) throw new BoronganError(`${cur.number} sudah dikirim`);
    const tasksIn = cur.tasks.map((t) => ({ taskId: t.taskId, qty: t.qty }));
    const tasks = await loadTasks(tx, tasksIn);
    const day = input.date || todayStr();
    const d = await dispatchTx(tx, cur.number, day, input, tasks, tasksIn, actor);
    const s = await tx.boronganShipment.update({
      where: { id },
      data: { waitingSupport: false, mode: input.mode, pointIds: d.pointIds, driverId: d.driverId, completedBy: actor.name, completedAt: new Date(), ...(input.note ? { note: [cur.note, input.note].filter(Boolean).join(" · ") } : {}), lines: { create: d.rows } },
    });
    await audit(actor, "KIRIMAN_BORONGAN", "BoronganShipment", id, { number: cur.number, mode: input.mode, titik: d.points.map((p) => p.code), jenis: tasksIn, dilengkapi: true }, tx);
    return { s, total: tasksIn.reduce((a, t) => a + t.qty, 0) };
  }, { timeout: 30000 });
  await notifyDispatched(s.s, s.total);
  return s.s;
}

/** Batalkan kiriman yang belum pernah diambil setorannya: semua bahan kembali ke gudang */
export async function cancelShipment(id: string, actor: Actor, scope: Scope) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganShipment" WHERE id = ${id} FOR UPDATE`;
    const s = await tx.boronganShipment.findUniqueOrThrow({ where: { id }, include: { pickups: true, _count: { select: { allots: true } } } });
    if (!canCancelShipment(scope, s, actor.id)) throw new BoronganError("Kiriman hanya bisa dibatalkan Owner, atau pencatatnya selama belum dibagi ke pekerja");
    if (s.cancelledAt) throw new BoronganError(`${s.number} sudah dibatalkan`);
    if (s.pickups.some((p) => p.status !== "DIBATALKAN")) throw new BoronganError("Kiriman yang sudah diambil setorannya tidak bisa dibatalkan");
    await reverseMovementsByRef(tx, `BGI:${s.number}`, `BATAL-BGI:${s.number}`, "Kiriman dibatalkan", actor);
    await reverseMovementsByRef(tx, `KRM:${s.number}`, `BATAL-KRM:${s.number}`, "Kiriman dibatalkan", actor);
    await tx.boronganShipment.update({ where: { id }, data: { cancelledAt: new Date(), cancelledBy: actor.name } });
    await audit(actor, "KIRIMAN_BORONGAN_DIBATALKAN", "BoronganShipment", id, { number: s.number }, tx);
  });
}

// ---------------- 2. PEMBAGIAN KE PEKERJA ----------------

export type AllotInput = { pointId: string; workerId: string; taskId: string; qty: number };

/**
 * Stok bahan yang seharusnya sudah ada di tiap titik menurut pembagian (kiriman lewat driver):
 * bahan resep = jumlah dibagi × takaran; bahan pendukung = sebanding jumlah pcs yang dibagi ke titik itu.
 */
export function allotStockPlan(
  lines: { itemId: string; qty: number; support: boolean }[],
  tasks: { taskId: string; qty: number; inputs: { itemId: string; per: number }[] }[],
  allots: AllotInput[],
): Map<string, Map<string, number>> {
  const plan = new Map<string, Map<string, number>>();
  const put = (pointId: string, itemId: string, q: number) => {
    if (q <= 0) return;
    const m = plan.get(pointId) ?? new Map<string, number>();
    m.set(itemId, Math.round(((m.get(itemId) ?? 0) + q) * 1000) / 1000);
    plan.set(pointId, m);
  };
  const byPoint = new Map<string, number>();
  for (const a of allots) byPoint.set(a.pointId, (byPoint.get(a.pointId) ?? 0) + a.qty);
  const sentAll = tasks.reduce((s, t) => s + t.qty, 0);
  const allottedAll = [...byPoint.values()].reduce((s, x) => s + x, 0);
  for (const l of lines) {
    const users = l.support ? [] : tasks.filter((t) => t.inputs.some((i) => i.itemId === l.itemId));
    if (users.length) {
      let left = l.qty;
      for (const a of allots) {
        const t = users.find((x) => x.taskId === a.taskId);
        if (!t) continue;
        const q = Math.min(left, t.inputs.filter((i) => i.itemId === l.itemId).reduce((s, i) => s + i.per, 0) * a.qty);
        put(a.pointId, l.itemId, q);
        left -= q;
      }
    } else if (sentAll > 0 && allottedAll > 0) {
      const amount = l.qty * Math.min(1, allottedAll / sentAll);
      const dec = Number.isInteger(l.qty) ? 0 : 3;
      for (const [pointId, q] of splitByWeights(amount, [...byPoint], dec)) put(pointId, l.itemId, q);
    }
  }
  return plan;
}

export async function saveAllots(shipmentId: string, rows: AllotInput[], actor: Actor, scope: Scope, opts: { reason?: string } = {}) {
  const out = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganShipment" WHERE id = ${shipmentId} FOR UPDATE`;
    const s = await tx.boronganShipment.findUniqueOrThrow({ where: { id: shipmentId }, include: { tasks: { include: { task: { include: { inputs: { include: { item: true } } } } } }, lines: true, allots: true, pickups: { where: { status: { not: "DIBATALKAN" } }, include: { lines: true } } } });
    if (s.cancelledAt) throw new BoronganError(`${s.number} sudah dibatalkan`);
    if (s.waitingSupport) throw new BoronganError(`${s.number} masih menunggu bahan pendukung dari tim Assembling`);
    const taskIds = s.tasks.map((t) => t.taskId);
    if (!canDistribute(scope, { mode: s.mode, taskIds })) throw new BoronganError(s.mode === "DRIVER" ? "Pembagian kiriman lewat driver dicatat driver" : "Pembagian kiriman ini dicatat tim divisi / Supervisor");
    // Setelah ada pengambilan (AMB) pertama, pembagian dikunci: driver/tim divisi tidak bisa mengubah; hanya Supervisor/Owner (backup) dengan alasan
    const reason = opts.reason?.trim() ?? "";
    if (s.pickups.length > 0) {
      if (!fullAccess(scope)) throw new BoronganError("Pembagian tidak bisa diubah setelah ada pengambilan setoran (AMB). Minta Supervisor/Owner.");
      if (reason.length < 3) throw withField(new BoronganError("Pembagian sudah dikunci oleh pengambilan (AMB): tulis alasan perubahan"), "reason");
    }
    const clean = new Map<string, AllotInput>();
    for (const r of rows) {
      if (!Number.isInteger(r.qty) || r.qty < 0) throw new BoronganError("Jumlah harus bilangan bulat, tidak minus");
      if (!s.pointIds.includes(r.pointId)) throw new BoronganError("Titik ini bukan tujuan kiriman");
      if (!taskIds.includes(r.taskId)) throw new BoronganError("Jenis pekerjaan bukan bagian kiriman ini");
      const k = `${r.workerId}:${r.taskId}`;
      clean.set(k, { ...r, qty: (clean.get(k)?.qty ?? 0) + r.qty });
    }
    const workers = await tx.boronganPerson.findMany({ where: { id: { in: [...new Set([...clean.values()].map((r) => r.workerId))] } } });
    for (const r of clean.values()) {
      if (!r.qty) continue;
      const w = workers.find((x) => x.id === r.workerId);
      if (!w || w.role !== "PEKERJA" || !w.active || w.pointId !== r.pointId) throw new BoronganError("Pekerja tidak terdaftar aktif di titik itu");
      if (w.taskIds.length && !w.taskIds.includes(r.taskId)) throw new BoronganError(`${w.name} tidak mengerjakan ${s.tasks.find((t) => t.taskId === r.taskId)?.task.name}`);
    }
    for (const t of s.tasks) {
      const sum = [...clean.values()].filter((r) => r.taskId === t.taskId).reduce((a, r) => a + r.qty, 0);
      if (sum > t.qty) throw new BoronganError(`${shortTaskName(t.task.name)} dibagi ${sum.toLocaleString("id-ID")}, melebihi kiriman ${t.qty.toLocaleString("id-ID")}`);
    }
    // Tidak boleh kurang dari yang sudah diambil driver
    const taken = new Map<string, number>();
    for (const p of s.pickups) for (const l of p.lines) taken.set(`${l.workerId}:${l.taskId}`, (taken.get(`${l.workerId}:${l.taskId}`) ?? 0) + l.qty);
    for (const a of s.allots) {
      const k = `${a.workerId}:${a.taskId}`;
      const got = taken.get(k) ?? 0;
      if (got > 0 && (clean.get(k)?.qty ?? 0) < got) throw new BoronganError(`Pembagian ${workers.find((w) => w.id === a.workerId)?.name ?? "pekerja"} tidak boleh kurang dari yang sudah diambil (${got})`);
    }
    await tx.boronganAllot.deleteMany({ where: { shipmentId } });
    const final = [...clean.values()].filter((r) => r.qty > 0);
    if (final.length) await tx.boronganAllot.createMany({ data: final.map((r) => ({ shipmentId, pointId: r.pointId, workerId: r.workerId, taskId: r.taskId, qty: r.qty, updatedBy: actor.name })) });
    // Lewat driver: bahan pindah dari lokasi driver ke lokasi titik sesuai pembagian (selisih terhadap yang sudah dipindah)
    if (s.mode === "DRIVER") {
      const plan = allotStockPlan(
        s.lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty), support: l.support })),
        s.tasks.map((t) => ({ taskId: t.taskId, qty: t.qty, inputs: t.task.inputs.map((i) => ({ itemId: i.itemId, per: bomStockQty(i.qty, i.item) })) })),
        final,
      );
      const drv = await driverLocation(tx);
      const points = await tx.boronganPoint.findMany({ where: { id: { in: s.pointIds } } });
      const moves = await tx.stockMovement.findMany({ where: { ref: `BGI:${s.number}` } });
      for (const p of points) {
        const want = plan.get(p.id) ?? new Map<string, number>();
        const itemIds = new Set([...want.keys(), ...moves.filter((m) => m.toLocationId === p.locationId || m.fromLocationId === p.locationId).map((m) => m.itemId)]);
        for (const itemId of itemIds) {
          const have = moves.filter((m) => m.itemId === itemId).reduce((a, m) => a + (m.toLocationId === p.locationId ? Number(m.qty) : m.fromLocationId === p.locationId ? -Number(m.qty) : 0), 0);
          const delta = Math.round(((want.get(itemId) ?? 0) - have) * 1000) / 1000;
          if (Math.abs(delta) < 0.0005) continue;
          await recordMovement(tx, { type: "TRANSFER", itemId, qty: Math.abs(delta), fromLocationId: delta > 0 ? drv : p.locationId, toLocationId: delta > 0 ? p.locationId : drv, allowNegative: true, ref: `BGI:${s.number}`, note: `Pembagian ${s.number} ${p.name}` }, actor);
        }
      }
    }
    // Audit nilai sebelum → sesudah per pekerja & jenis (nama dibaca untuk keterbacaan)
    const names = new Map((await tx.boronganPerson.findMany({ where: { id: { in: [...new Set([...s.allots.map((a) => a.workerId), ...final.map((r) => r.workerId)])] } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
    const label = (a: { workerId: string; taskId: string }) => `${names.get(a.workerId) ?? a.workerId} · ${shortTaskName(s.tasks.find((t) => t.taskId === a.taskId)?.task.name ?? a.taskId)}`;
    const sebelum = Object.fromEntries(s.allots.map((a) => [label(a), a.qty]));
    const sesudah = Object.fromEntries(final.map((a) => [label(a), a.qty]));
    await audit(actor, "PEMBAGIAN_BORONGAN", "BoronganShipment", shipmentId, { number: s.number, baris: final.length, total: final.reduce((a, r) => a + r.qty, 0), sebelum, sesudah, ...(reason ? { alasan: reason } : {}), ...(s.pickups.length ? { setelahPengambilan: true } : {}) }, tx);
    const left = s.tasks.reduce((a, t) => a + t.qty, 0) - final.reduce((a, r) => a + r.qty, 0);
    const perPoint = new Map<string, number>();
    for (const r of final) perPoint.set(r.pointId, (perPoint.get(r.pointId) ?? 0) + r.qty);
    return { number: s.number, left, perPoint };
  }, { timeout: 30000 });
  // Push ke HP koordinator tiap titik yang mendapat pembagian
  for (const [pointId, qty] of out.perPoint) {
    await notify(await coordinatorUsers([pointId]), { title: `Bahan ${out.number} sudah dibagi`, body: `${qty.toLocaleString("id-ID")} pcs dibagikan ke pekerja di titik Anda. Lapor hasil lewat Borongan › Kiriman.`, url: "/borongan?tab=kiriman", tag: `bgi-${out.number}-${pointId}` });
  }
  return { number: out.number, left: out.left };
}

// ---------------- 3. LAPOR HASIL ----------------

export type ReportInput = { workerId: string; taskId: string; good: number; reject: number };

export async function saveWorkReport(shipmentId: string, pointId: string, rows: ReportInput[], checked: boolean, actor: Actor, scope: Scope, opts: { reason?: string } = {}) {
  const rep = await saveWorkReportTx(shipmentId, pointId, rows, checked, actor, scope, opts);
  // Driver: setoran titik ini siap diambil
  const s = await prisma.boronganShipment.findUnique({ where: { id: shipmentId }, select: { number: true, mode: true, driver: { select: { userId: true } } } });
  const point = await prisma.boronganPoint.findUnique({ where: { id: pointId }, select: { name: true } });
  if (s?.mode === "DRIVER" && s.driver?.userId) {
    const good = rows.reduce((a, r) => a + r.good, 0);
    await notify([s.driver.userId], { title: `Setoran ${point?.name ?? ""} siap diambil`, body: `${s.number}: ${good.toLocaleString("id-ID")} pcs dilaporkan ${actor.name}. Ambil lewat Borongan › Kiriman › Ambil setoran.`, url: "/borongan?tab=kiriman", tag: `ambil-${s.number}-${pointId}` });
  }
  return rep;
}

async function saveWorkReportTx(shipmentId: string, pointId: string, rows: ReportInput[], checked: boolean, actor: Actor, scope: Scope, opts: { reason?: string } = {}) {
  return prisma.$transaction(async (tx) => {
    const s = await tx.boronganShipment.findUniqueOrThrow({ where: { id: shipmentId }, include: { tasks: true, allots: { where: { pointId } } } });
    if (s.cancelledAt) throw new BoronganError(`${s.number} sudah dibatalkan`);
    if (!s.pointIds.includes(pointId)) throw new BoronganError("Titik ini bukan tujuan kiriman");
    const only = await coordinatorOnly(tx, pointId);
    if (!canReport(scope, { taskIds: s.tasks.map((t) => t.taskId) }, pointId, only)) throw new BoronganError(only ? "Laporan hasil dicatat koordinator titik" : "Laporan hasil titik ini dicatat koordinator pencatat / tim divisi / Supervisor");
    if (!s.allots.length) throw new BoronganError("Kiriman ini belum dibagi ke pekerja di titik ini");
    const lines: ReportInput[] = [];
    for (const a of s.allots) {
      const r = rows.find((x) => x.workerId === a.workerId && x.taskId === a.taskId) ?? { workerId: a.workerId, taskId: a.taskId, good: 0, reject: 0 };
      if (![r.good, r.reject].every((n) => Number.isInteger(n) && n >= 0)) throw new BoronganError("Setoran dan reject harus bilangan bulat, tidak minus");
      if (r.good + r.reject > a.qty) throw new BoronganError(`Setoran + reject melebihi yang dibagi (${a.qty})`);
      lines.push(r);
    }
    if (lines.some((l) => l.reject > 0) && !checked) throw new BoronganError("Centang \"Reject sudah dicek koordinator\" dulu");
    // Laporan pekerja yang pengambilannya (AMB) sudah dihitung divisi dikunci: koreksi hanya Supervisor/Owner dengan alasan
    const counted = await tx.boronganPickupLine.findMany({ where: { pointId, pickup: { shipmentId, status: { in: ["DITERIMA", "KURANG"] } } }, select: { workerId: true, taskId: true } });
    const lockedKeys = new Set(counted.map((l) => `${l.workerId}:${l.taskId}`));
    const prevRep = await tx.boronganWorkReport.findFirst({ where: { shipmentId, pointId }, include: { lines: true }, orderBy: { createdAt: "desc" } });
    const prevMap = new Map((prevRep?.lines ?? []).map((l) => [`${l.workerId}:${l.taskId}`, l]));
    const key = (l: { workerId: string; taskId: string }) => `${l.workerId}:${l.taskId}`;
    const changedLocked = lines.filter((l) => lockedKeys.has(key(l)) && ((prevMap.get(key(l))?.good ?? 0) !== l.good || (prevMap.get(key(l))?.reject ?? 0) !== l.reject));
    const reason = opts.reason?.trim() ?? "";
    if (changedLocked.length) {
      if (!fullAccess(scope)) throw new BoronganError("Laporan pekerja yang setorannya sudah dihitung divisi tidak bisa diubah. Koreksi lewat Supervisor/Owner.");
      if (reason.length < 3) throw withField(new BoronganError("Laporan ini sudah dihitung divisi: tulis alasan koreksi"), "reason");
    }
    const rep = await tx.boronganWorkReport.create({ data: { shipmentId, pointId, checked, createdBy: actor.name, createdById: actor.id, lines: { create: lines } } });
    const names = new Map((await tx.boronganPerson.findMany({ where: { id: { in: lines.map((l) => l.workerId) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
    const label = (l: { workerId: string; taskId: string }) => `${names.get(l.workerId) ?? l.workerId}:${l.taskId}`;
    const sebelum = Object.fromEntries(lines.map((l) => [label(l), `${prevMap.get(key(l))?.good ?? 0}/${prevMap.get(key(l))?.reject ?? 0}`]));
    const sesudah = Object.fromEntries(lines.map((l) => [label(l), `${l.good}/${l.reject}`]));
    await audit(actor, "LAPORAN_HASIL_BORONGAN", "BoronganShipment", shipmentId, { number: s.number, titik: pointId, setoran: lines.reduce((a, l) => a + l.good, 0), reject: lines.reduce((a, l) => a + l.reject, 0), sebelum, sesudah, formatNilai: "setoran/reject", ...(reason ? { alasan: reason } : {}) }, tx);
    return rep;
  });
}

// ---------------- 4. AMBIL SETORAN ----------------

export type PickupInput = { pointId: string; workerId: string; taskId: string; qty: number; done: boolean };

async function notify(userIds: (string | null | undefined)[], payload: PushPayload) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (ids.length) await sendPush(ids, payload).catch(() => {});
}
async function coordinatorUsers(pointIds: string[]) {
  return (await prisma.boronganPerson.findMany({ where: { ...coordinatorsAt(pointIds), userId: { not: null } }, select: { userId: true } })).map((p) => p.userId);
}

export async function createPickup(shipmentId: string, rows: PickupInput[], actor: Actor, scope: Scope, day: string = todayStr()) {
  const out = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganShipment" WHERE id = ${shipmentId} FOR UPDATE`;
    const s = await tx.boronganShipment.findUniqueOrThrow({ where: { id: shipmentId }, include: shipmentInclude });
    if (s.cancelledAt) throw new BoronganError(`${s.number} sudah dibatalkan`);
    if (!canPickup(scope, { mode: s.mode, taskIds: s.tasks.map((t) => t.taskId) })) throw new BoronganError(s.mode === "DRIVER" ? "Setoran kiriman lewat driver diambil driver" : "Pengambilan kiriman ini dicatat tim divisi / Supervisor");
    const [view] = await buildViews([s]);
    const lines: (PickupInput & { reject: number })[] = [];
    for (const r of rows) {
      if (!Number.isInteger(r.qty) || r.qty < 0) throw new BoronganError("Setoran harus bilangan bulat, tidak minus");
      if (!r.qty && !r.done) continue;
      const c = view.cells.find((x) => x.workerId === r.workerId && x.taskId === r.taskId);
      if (!c) throw new BoronganError("Pekerja ini tidak mendapat pembagian jenis itu");
      if (c.done) throw new BoronganError(`${c.worker} sudah selesai di pengambilan sebelumnya`);
      if (r.qty > c.dibagi - c.diambil) throw new BoronganError(`Setoran ${c.worker} (${r.qty}) melebihi sisa yang dibagi (${c.dibagi - c.diambil})`);
      lines.push({ ...r, pointId: c.pointId, reject: c.reject });
    }
    if (!lines.length) throw withField(new BoronganError("Isi setoran minimal satu pekerja"), "q");
    const number = await dailyNumber(tx, "AMB", day);
    const driverId = scope.driver ? scope.personId : s.mode === "DRIVER" ? s.driverId : null;
    const p = await tx.boronganPickup.create({
      data: { number, shipmentId, date: dateOnly(day), driverId, createdBy: actor.name, createdById: actor.id, lines: { create: lines.map((l) => ({ pointId: l.pointId, workerId: l.workerId, taskId: l.taskId, qty: l.qty, reject: l.reject, done: l.done })) } },
    });
    await audit(actor, "AMBIL_SETORAN_BORONGAN", "BoronganPickup", p.id, { number, kiriman: s.number, total: lines.reduce((a, l) => a + l.qty, 0) }, tx);
    // Setoran driver ≠ laporan koordinator (pada sel yang ditutup "Selesai semua") → beri tahu koordinator
    const mismatch = lines.filter((l) => l.done).map((l) => ({ l, c: view.cells.find((x) => x.workerId === l.workerId && x.taskId === l.taskId)! })).filter(({ l, c }) => c.reported && c.diambil + l.qty !== c.good);
    return { pickup: p, number, kiriman: s.number, mismatch: mismatch.map(({ l, c }) => ({ pointId: l.pointId, text: `${c.worker} ${shortTaskName(view.tasks.find((t) => t.id === l.taskId)?.name ?? "")}: driver ${c.diambil + l.qty}, laporan ${c.good}` })) };
  }, { timeout: 30000 });
  if (out.mismatch.length) {
    await notify(await coordinatorUsers([...new Set(out.mismatch.map((m) => m.pointId))]), { title: `Setoran ${out.kiriman} berbeda dengan laporan`, body: out.mismatch.map((m) => m.text).join(" · ").slice(0, 300), url: "/borongan?tab=kiriman", tag: `amb-${out.number}` });
  }
  return out.pickup;
}

/**
 * Batalkan pengambilan (AMB). Wajib alasan (konfirmasi di layar).
 *  - "Menunggu dihitung": pencatatnya (driver/tim) hanya untuk AMB MILIKNYA dan dibuat HARI INI (zona Asia/Jakarta); setelah itu hanya Supervisor/Owner.
 *  - Sudah dihitung/diterima divisi (Diterima/Kurang): hanya Owner, dengan pembalik (setoran, stok & jurnal dibalik; upah yang sudah dibayar menolak).
 *  - Koordinator tidak pernah boleh membatalkan.
 */
export async function cancelPickup(id: string, actor: Actor, scope: Scope, reason = "") {
  const why = reason.trim();
  if (why.length < 3) throw withField(new BoronganError("Tulis alasan pembatalan"), "reason");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganPickup" WHERE id = ${id} FOR UPDATE`;
    const p = await tx.boronganPickup.findUniqueOrThrow({ where: { id }, include: { shipment: { include: { tasks: true } }, results: true, lines: true } });
    if (p.status === "DIBATALKAN") throw new BoronganError(`${p.number} sudah dibatalkan`);
    if (isCoordinatorScope(scope)) throw new BoronganError("Koordinator tidak bisa membatalkan pengambilan");
    const before = { status: p.status, setoran: p.lines.reduce((a, l) => a + l.qty, 0) };
    if (p.status !== "DIBAWA") {
      if (!scope.owner) throw new BoronganError("Pengambilan yang sudah dihitung/diterima divisi hanya bisa dibatalkan Owner");
      if (p.results.some((r) => r.settlementId)) throw new BoronganError("Upah pengambilan ini sudah dibayar, tidak bisa dibatalkan");
      for (const r of p.results) await unpostResultTx(tx, r.id, actor, `Pembatalan ${p.number}: ${why}`);
      await reverseMovementsByRef(tx, `AMB:${p.number}`, `BATAL-AMB:${p.number}`, `Pembatalan ${p.number}: ${why}`, actor);
      await tx.boronganPickup.update({ where: { id }, data: { status: "DIBATALKAN" } });
      await audit(actor, "AMBIL_SETORAN_DIBALIK_OWNER", "BoronganPickup", id, { number: p.number, alasan: why, sebelum: before, sesudah: { status: "DIBATALKAN" } }, tx);
      return;
    }
    if (!fullAccess(scope)) {
      if (p.createdById !== actor.id) throw new BoronganError("Hanya pencatatnya, Supervisor, atau Owner yang bisa membatalkan pengambilan ini");
      if (todayStr(p.createdAt) !== todayStr()) throw new BoronganError("Pengambilan hanya bisa dibatalkan pencatatnya pada hari yang sama. Minta Supervisor/Owner.");
    }
    await tx.boronganPickup.update({ where: { id }, data: { status: "DIBATALKAN" } });
    await audit(actor, "AMBIL_SETORAN_DIBATALKAN", "BoronganPickup", id, { number: p.number, alasan: why, sebelum: before, sesudah: { status: "DIBATALKAN" } }, tx);
  });
}

// ---------------- 5. TERIMA SETORAN ----------------

async function postPickupResults(tx: Tx, pickupId: string, held: boolean, actor: Actor) {
  const p = await tx.boronganPickup.findUniqueOrThrow({ where: { id: pickupId }, include: { lines: true, shipment: true } });
  const taskIds = [...new Set(p.lines.map((l) => l.taskId))];
  const [tasks, points, workers] = await Promise.all([
    tx.pieceTask.findMany({ where: { id: { in: taskIds } }, include: { inputs: { include: { item: true } }, outputItem: true } }),
    tx.boronganPoint.findMany({ where: { id: { in: [...new Set(p.lines.map((l) => l.pointId))] } } }),
    tx.boronganPerson.findMany({ where: { id: { in: [...new Set(p.lines.map((l) => l.workerId))] } }, select: { id: true, name: true } }),
  ]);
  // Reject laporan koordinator yang belum dibukukan di pengambilan lain kiriman yang sama
  const prior = await tx.boronganResult.groupBy({ by: ["workerId", "taskId"], where: { pickup: { shipmentId: p.shipmentId }, pickupId: { not: p.id } }, _sum: { reject: true } });
  const reps = await tx.boronganWorkReport.findMany({ where: { shipmentId: p.shipmentId }, include: { lines: true }, orderBy: { createdAt: "desc" } });
  const latest = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of reps) {
    if (seen.has(r.pointId)) continue;
    seen.add(r.pointId);
    for (const l of r.lines) latest.set(`${l.workerId}:${l.taskId}`, l.reject);
  }
  const coordOf = new Map<string, string | null>();
  for (const w of await tx.boronganPerson.findMany({ where: { id: { in: workers.map((x) => x.id) } }, select: { id: true, coordinatorId: true, pointId: true, noCoordinator: true } })) coordOf.set(w.id, (await coordinatorFor(tx, w))?.id ?? null);
  for (const l of p.lines) {
    const k = `${l.workerId}:${l.taskId}`;
    const accounted = prior.find((x) => x.workerId === l.workerId && x.taskId === l.taskId)?._sum.reject ?? 0;
    const reject = rejectToAccount(latest.get(k) ?? 0, accounted);
    if (!l.qty && !reject) continue;
    const point = points.find((x) => x.id === l.pointId)!;
    await postResultTx(tx, {
      point, worker: workers.find((w) => w.id === l.workerId)!, task: tasks.find((t) => t.id === l.taskId)!, date: p.date, qty: l.qty, reject,
      coordinatorId: coordOf.get(l.workerId) ?? null, driverId: p.driverId, pickupId: p.id, held, allowNegative: true, note: `${p.number} (${p.shipment.number})`,
    }, actor);
  }
}

/**
 * Barang hasil pindah dari titik ke gudang sebanyak yang dihitung divisi (maksimal setoran driver per jenis).
 * Berbasis selisih terhadap yang sudah dipindah dengan ref AMB:<nomor>, jadi aman dipanggil ulang setelah koreksi.
 */
async function syncPickupOutput(tx: Tx, pickupId: string, counted: Map<string, number>, actor: Actor) {
  const p = await tx.boronganPickup.findUniqueOrThrow({ where: { id: pickupId }, include: { lines: true } });
  const ref = `AMB:${p.number}`;
  const [tasks, points, moves] = await Promise.all([
    tx.pieceTask.findMany({ where: { id: { in: [...new Set(p.lines.map((l) => l.taskId))] } }, include: { outputItem: true } }),
    tx.boronganPoint.findMany({ where: { id: { in: [...new Set(p.lines.map((l) => l.pointId))] } } }),
    tx.stockMovement.findMany({ where: { ref } }),
  ]);
  for (const t of tasks) {
    if (!t.outputItem) continue;
    const warehouse = await warehouseFor(tx, t.outputItem.type);
    const want = new Map<string, number>();
    let left = counted.get(t.id) ?? 0;
    for (const l of p.lines.filter((x) => x.taskId === t.id)) {
      const q = Math.min(left, l.qty);
      if (q <= 0) continue;
      left -= q;
      want.set(l.pointId, (want.get(l.pointId) ?? 0) + q);
    }
    for (const pt of points) {
      const have = moves.filter((m) => m.itemId === t.outputItem!.id).reduce((a, m) => a + (m.fromLocationId === pt.locationId ? Number(m.qty) : m.toLocationId === pt.locationId ? -Number(m.qty) : 0), 0);
      const delta = (want.get(pt.id) ?? 0) - have;
      if (Math.abs(delta) < 0.0005) continue;
      await recordMovement(tx, { type: "TRANSFER", itemId: t.outputItem.id, qty: Math.abs(delta), fromLocationId: delta > 0 ? pt.locationId : warehouse, toLocationId: delta > 0 ? warehouse : pt.locationId, allowNegative: true, ref, note: `Setoran ${p.number} ${delta > 0 ? "dari" : "dikembalikan ke"} ${pt.name}`, date: new Date(`${dateStr(p.date)}T06:00:00.000Z`) }, actor);
    }
  }
}

export async function receivePickup(pickupId: string, counts: { taskId: string; qty: number }[], actor: Actor, scope: Scope) {
  const out = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganPickup" WHERE id = ${pickupId} FOR UPDATE`;
    const p = await tx.boronganPickup.findUniqueOrThrow({ where: { id: pickupId }, include: { lines: true, shipment: true, driver: true } });
    if (p.status !== "DIBAWA") throw new BoronganError(`${p.number} sudah diproses`);
    const taskIds = [...new Set(p.lines.map((l) => l.taskId))];
    const tasks = await tx.pieceTask.findMany({ where: { id: { in: taskIds } }, select: { id: true, name: true, divisionId: true } });
    if (!canReceive(scope, tasks)) throw new BoronganError("Setoran ini diterima oleh divisi penerima (Assembling / Giftbox)");
    const counted = new Map<string, number>();
    for (const c of counts) {
      if (!taskIds.includes(c.taskId)) continue;
      if (!Number.isInteger(c.qty) || c.qty < 0) throw new BoronganError("Jumlah dihitung harus bilangan bulat, tidak minus");
      counted.set(c.taskId, c.qty);
    }
    if (counted.size !== taskIds.length) throw new BoronganError("Isi hitungan setiap jenis");
    const driver = new Map<string, number>();
    for (const l of p.lines) driver.set(l.taskId, (driver.get(l.taskId) ?? 0) + l.qty);
    const check = checkCounts(driver, counted);
    await postPickupResults(tx, p.id, check.short, actor);
    await syncPickupOutput(tx, p.id, counted, actor);
    await tx.boronganPickupCount.createMany({ data: [...counted].map(([taskId, qty]) => ({ pickupId: p.id, taskId, qty })) });
    const name = (id: string) => shortTaskName(tasks.find((t) => t.id === id)?.name ?? "");
    const holdNote = check.short ? `Hitungan kurang: ${check.rows.filter((r) => r.diff < 0).map((r) => `${name(r.taskId)} ${r.counted} dari ${r.driver}`).join(", ")}` : null;
    await tx.boronganPickup.update({ where: { id: p.id }, data: { status: check.short ? "KURANG" : "DITERIMA", receivedAt: new Date(), receivedBy: actor.name, receivedById: actor.id, holdNote } });
    await audit(actor, "TERIMA_SETORAN_BORONGAN", "BoronganPickup", p.id, { number: p.number, hitungan: Object.fromEntries(counted), kurang: check.short || undefined }, tx);
    return { number: p.number, kiriman: p.shipment.number, short: check.short, holdNote, driverUser: p.driver?.userId ?? null, pointIds: [...new Set(p.lines.map((l) => l.pointId))], rows: check.rows };
  }, { timeout: 60000 });
  if (out.short) {
    const sup = (await prisma.user.findMany({ where: { role: "SUPERVISOR", active: true }, select: { id: true } })).map((u) => u.id);
    const payload = { title: `Setoran ${out.number} kurang, upah ditahan`, body: `${out.holdNote} (kiriman ${out.kiriman}). Cek dan koreksi di Borongan.`, url: "/borongan?tab=kiriman", tag: `amb-${out.number}` };
    await notify([out.driverUser, ...sup], payload);
    await notify(await coordinatorUsers(out.pointIds), { ...payload, title: `Setoran ${out.number} dihitung kurang oleh divisi` });
  }
  return out;
}

/**
 * Tindak lanjut pengambilan yang kurang (Supervisor/pengelola):
 *  - koreksi setoran driver per pekerja (mis. driver salah hitung): setoran & upah dihitung ulang, bila sudah cocok upah dilepas;
 *  - atau lepas tahanan dengan alasan (upah dibayar sesuai setoran driver, selisih barang tetap tercatat di titik).
 */
export async function resolvePickup(pickupId: string, input: { reason: string; lines?: { id: string; qty: number }[] }, actor: Actor, scope: Scope) {
  if (!scope.all) throw new BoronganError("Pengambilan yang kurang dicek Supervisor / pengelola borongan");
  const reason = input.reason?.trim();
  if (!reason) throw withField(new BoronganError("Alasan wajib diisi"), "reason");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganPickup" WHERE id = ${pickupId} FOR UPDATE`;
    const p = await tx.boronganPickup.findUniqueOrThrow({ where: { id: pickupId }, include: { lines: true, counts: true, results: true } });
    if (p.status !== "KURANG") throw new BoronganError(`${p.number} tidak sedang ditahan`);
    if (p.results.some((r) => r.settlementId)) throw new BoronganError("Upah pengambilan ini sudah dibayar");
    const counted = new Map(p.counts.map((c) => [c.taskId, c.qty]));
    let short = false;
    if (input.lines?.length) {
      for (const c of input.lines) {
        const l = p.lines.find((x) => x.id === c.id);
        if (!l) throw new BoronganError("Baris tidak ditemukan");
        if (!Number.isInteger(c.qty) || c.qty < 0) throw new BoronganError("Setoran harus bilangan bulat, tidak minus");
        if (c.qty !== l.qty) await tx.boronganPickupLine.update({ where: { id: l.id }, data: { qty: c.qty } });
      }
      // Hitung ulang: hapus setoran lama pengambilan ini (stok & jurnal dibalik), posting ulang dengan angka koreksi
      for (const r of p.results) await unpostResultTx(tx, r.id, actor, `Koreksi ${p.number}`);
      const fresh = await tx.boronganPickupLine.findMany({ where: { pickupId } });
      const driver = new Map<string, number>();
      for (const l of fresh) driver.set(l.taskId, (driver.get(l.taskId) ?? 0) + l.qty);
      short = checkCounts(driver, counted).short;
      await postPickupResults(tx, pickupId, short, actor);
      await syncPickupOutput(tx, pickupId, counted, actor);
    } else {
      await tx.boronganResult.updateMany({ where: { pickupId }, data: { held: false } });
    }
    await tx.boronganPickup.update({ where: { id: pickupId }, data: short ? { holdNote: `${p.holdNote ?? ""} · dikoreksi ${actor.name}: ${reason}`.slice(0, 500) } : { status: "DITERIMA", releasedAt: new Date(), releasedBy: actor.name, holdNote: `${p.holdNote ?? ""} · ${input.lines?.length ? "dikoreksi" : "dilepas"} ${actor.name}: ${reason}`.slice(0, 500) } });
    await audit(actor, input.lines?.length ? "SETORAN_BORONGAN_DIKOREKSI" : "UPAH_DITAHAN_DILEPAS", "BoronganPickup", pickupId, { number: p.number, alasan: reason, masihKurang: short || undefined }, tx);
    return { number: p.number, short };
  }, { timeout: 60000 });
}
