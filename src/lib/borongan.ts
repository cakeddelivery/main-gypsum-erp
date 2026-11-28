import { Prisma, type BoronganRole, type HandoverKind, type ItemType } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { COA, assertPeriodOpen, postJournal, reverseJournal } from "./accounting";
import { nextNumber } from "./numbering";
import { INVENTORY_COA, StockError, locationSettings, qtyAt, recordMovement, reverseMovementsByRef } from "./stock";
import { bomStockQty } from "./unitcost";
import { pointConfig } from "./boronganSetup";

type Tx = Prisma.TransactionClient;
type DB = Tx | typeof prisma;
type Actor = { id: string; name: string };

/** Turunan StockError agar pesannya tampil apa adanya di form */
export class BoronganError extends StockError {}

export const BORONGAN_ROLE_LABEL: Record<BoronganRole, string> = { PEKERJA: "Pekerja", KOORDINATOR: "Koordinator", DRIVER: "Driver" };
export const HANDOVER_LABEL: Record<HandoverKind, string> = { KIRIM: "Kirim Bahan Ke Titik", KEMBALI: "Kirim Hasil Ke Gudang" };

export type Split = { workerRate: number; coordinatorRate: number; driverRate: number };

/** Budget per pcs harus habis dibagi ke pekerja, koordinator, dan driver */
export function checkSplit(total: number, s: Split) {
  if (total <= 0) throw new BoronganError("Budget per pcs harus lebih dari 0");
  if ([s.workerRate, s.coordinatorRate, s.driverRate].some((x) => x < 0)) throw new BoronganError("Bagian upah tidak boleh minus");
  const sum = s.workerRate + s.coordinatorRate + s.driverRate;
  if (sum !== total) throw new BoronganError(`Pembagian pekerja + koordinator + driver (Rp${sum}) harus sama dengan budget Rp${total}/pcs`);
}

/** Upah satu setoran per penerima */
export function resultShares(qty: number, s: Split) {
  return { worker: qty * s.workerRate, coordinator: qty * s.coordinatorRate, driver: qty * s.driverRate, total: qty * (s.workerRate + s.coordinatorRate + s.driverRate) };
}

// ---------------- AKSES ----------------

/**
 * all = pengelola borongan (semua titik, semua aksi).
 * warehouse = Kapten Assembling: semua titik, boleh kirim bahan & terima hasil ke gudang (tanpa tarif/upah/akun).
 * division = anggota divisi pencatat setoran (Kapten/Operator): hanya mencatat & membatalkan setoran TUGAS divisinya
 *   (taskIds), di titik yang mengerjakan tugas itu. Tidak mengatur tarif, pekerja, kirim bahan, atau bayar upah.
 *   captain = kapten boleh membatalkan semua setoran divisinya; anggota lain hanya setoran yang ia catat sendiri.
 * taskIds = null berarti semua tugas (pengelola, koordinator titik).
 */
export type Scope = {
  all: boolean;
  pointIds: string[];
  personId: string | null;
  warehouse?: boolean;
  taskIds?: string[] | null;
  division?: { id: string; captain: boolean; template?: string | null } | null;
  /** Tim Cetak/Oven: mengisi patung kering kiriman Assembling */
  kering?: boolean;
  /** Tim Packing: menerima setoran Assembling */
  packing?: boolean;
  /** Akun driver borongan (role DRIVER): hanya pembagian & ambil setoran kiriman lewat driver */
  driver?: boolean;
  /** Owner: boleh semua aksi, termasuk koreksi/lepas tahanan setoran */
  owner?: boolean;
  /** Pengelola borongan (Owner & Supervisor): BACKUP semua aksi kiriman (bagi, lapor, ambil, terima, batal) atas nama Driver/Koordinator/divisi; tercatat di audit */
  backup?: boolean;
};
type ScopeUser = { id: string; can: (p: "borongan.manage") => boolean; role?: string; divisionId?: string | null };

/** Kapten divisi Assembling ikut mengurus borongan (Assembling & Cat Plastik: bahan dikirim & setoran masuk) */
export async function isBoronganDivisionCaptain(db: DB, user: { role?: string; divisionId?: string | null }) {
  if (user.role !== "KAPTEN_DIVISI" || !user.divisionId) return false;
  const d = await db.division.findUnique({ where: { id: user.divisionId }, select: { reportTemplate: true } });
  return d?.reportTemplate === "ASSEMBLING";
}

/** Divisi Cetak / Oven: penghasil patung kering (mengisi patung kering kiriman Assembling) */
export const isKeringDivision = (d: { name: string; reportTemplate: string | null } | null | undefined) => !!d && (d.reportTemplate === "CETAK" || d.reportTemplate === "PRODUKSI" || /\b(cetak|oven)\b/i.test(d.name));

/** Anggota divisi (Kapten/Operator) yang divisinya punya tugas borongan aktif boleh mencatat setoran tugas itu */
export function isDivisionMemberRole(role?: string) {
  return role === "KAPTEN_DIVISI" || role === "OPERATOR";
}

export { assignDefaultTaskDivisions, defaultTaskTemplate } from "./taskDivision";

/** Koordinator aktif yang memegang titik ini (titik utama ATAU titik tambahan, mis. Mita: BMR + Beringin) */
export function coordinatorsAt(pointIds: string | string[]): Prisma.BoronganPersonWhereInput {
  const ids = Array.isArray(pointIds) ? pointIds : [pointIds];
  return { role: "KOORDINATOR", active: true, OR: [{ pointId: { in: ids } }, { extraPoints: { some: { pointId: { in: ids } } } }] };
}
/** Pilih untuk coordinatorCovers / coordinatorPoints */
export const coordinatorPointSelect = { pointId: true, extraPoints: { select: { pointId: true } } } as const;
/** Semua titik yang dipegang koordinator (utama + tambahan) */
export const coordinatorPoints = (c: { pointId: string | null; extraPoints?: { pointId: string }[] }) => [...new Set([c.pointId, ...(c.extraPoints ?? []).map((e) => e.pointId)].filter((x): x is string => !!x))];
export const coordinatorCovers = (c: { pointId: string | null; extraPoints?: { pointId: string }[] }, pointId: string) => coordinatorPoints(c).includes(pointId);

/** Pengelola melihat semua titik; Kapten Assembling & anggota divisi: titik yang mengerjakan tugas divisinya; koordinator hanya titiknya (utama + tambahan) */
export async function boronganScope(db: DB, user: ScopeUser): Promise<Scope> {
  if (user.can("borongan.manage")) return { all: true, owner: user.role === "OWNER", backup: true, pointIds: [], personId: null, taskIds: null };
  const coord = await db.boronganPerson.findFirst({ where: { userId: user.id, role: "KOORDINATOR", active: true }, include: { extraPoints: { select: { pointId: true } } } });
  if (coord) return { all: false, pointIds: coordinatorPoints(coord), personId: coord.id, taskIds: null };
  const drv = await db.boronganPerson.findFirst({ where: { userId: user.id, role: "DRIVER", active: true } });
  if (drv) {
    const points = await db.boronganPoint.findMany({ where: { active: true, viaDriver: true }, select: { id: true } });
    return { all: false, pointIds: points.map((p) => p.id), personId: drv.id, taskIds: null, driver: true };
  }
  if (isDivisionMemberRole(user.role) && user.divisionId) {
    const tasks = await db.pieceTask.findMany({ where: { divisionId: user.divisionId, active: true }, select: { id: true } });
    const captain = user.role === "KAPTEN_DIVISI";
    const warehouse = await isBoronganDivisionCaptain(db, user);
    const dv = await db.division.findUnique({ where: { id: user.divisionId }, select: { name: true, reportTemplate: true } });
    const kering = isKeringDivision(dv);
    const packing = dv?.reportTemplate === "PACKING";
    if (kering || packing) {
      const points = await db.boronganPoint.findMany({ where: { active: true }, select: { id: true } });
      return { all: false, pointIds: points.map((p) => p.id), personId: null, taskIds: [], division: { id: user.divisionId, captain, template: dv?.reportTemplate ?? null }, kering, packing };
    }
    if (tasks.length || warehouse) {
      const taskIds = tasks.map((t) => t.id);
      const points = await db.boronganPoint.findMany({ where: { active: true }, select: { id: true } });
      // Titik yang mengerjakan tugas divisi (menurut pengaturan tugas per titik); tanpa pengaturan = semua titik aktif
      const cfg = await pointConfig(db);
      const pointIds = points.map((p) => p.id).filter((id) => warehouse || !cfg[id]?.tasks.length || cfg[id].tasks.some((t) => taskIds.includes(t)));
      return { all: false, pointIds, personId: null, warehouse, taskIds, division: { id: user.divisionId, captain, template: dv?.reportTemplate ?? null } };
    }
  }
  return { all: false, pointIds: [], personId: null, taskIds: null };
}

/** Tugas boleh dicatat oleh scope ini */
export function canTask(scope: Scope, taskId: string) {
  return scope.all || scope.taskIds == null || scope.taskIds.includes(taskId);
}

/** Anggota divisi (bukan pengelola/Kapten Assembling): hanya setoran, tidak boleh serah terima, pekerja, tarif, upah */
export function isSetoranOnly(scope: Scope) {
  return !scope.all && !!scope.division && !scope.warehouse;
}

/** Boleh mengirim bahan dari gudang / menerima hasil ke gudang */
export function canWarehouse(scope: Scope) {
  return scope.all || !!scope.warehouse;
}

/** Kiriman hasil (KEMBALI) yang menunggu diterima dan memuat barang divisi ini (mis. pot cat giftbox untuk divisi Giftbox) */
export async function divisionPendingReturns(divisionId: string) {
  const d = await prisma.division.findUnique({ where: { id: divisionId }, select: { reportTemplate: true } });
  const list = await prisma.boronganHandover.findMany({ where: { status: "DIKIRIM", kind: "KEMBALI" }, include: { lines: { include: { item: true } }, point: true, driver: true }, orderBy: { date: "asc" } });
  return list.filter((h) => h.lines.some((l) => l.item.divisionId === divisionId || (d?.reportTemplate === "ASSEMBLING" && l.item.type !== "BAHAN_BAKU")));
}

export function canPoint(scope: Scope, pointId: string) {
  return scope.all || scope.pointIds.includes(pointId);
}

export function assertPoint(scope: Scope, pointId: string) {
  if (!canPoint(scope, pointId)) throw new BoronganError("Anda hanya bisa mengurus titik borongan Anda sendiri");
}

// ---------------- LOKASI ----------------

async function driverLocation(db: DB) {
  const s = await db.setting.findUnique({ where: { key: "loc_borongan_driver" } });
  if (s) return s.value;
  const l = await db.location.findUnique({ where: { code: "DRV" } });
  if (!l) throw new BoronganError("Lokasi driver borongan belum ada");
  return l.id;
}

/** Gudang asal/tujuan menurut jenis barang */
export async function warehouseFor(db: DB, type: ItemType) {
  const locs = await locationSettings(db);
  const id = type === "BAHAN_BAKU" ? locs.raw : type === "BARANG_DALAM_PROSES" ? locs.wip : locs.finished;
  if (!id) throw new BoronganError("Lokasi gudang belum diatur di Pengaturan");
  return id;
}

// ---------------- SERAH TERIMA LEWAT DRIVER ----------------

export type HandoverInput = { kind: HandoverKind; pointId: string; driverId?: string | null; date?: Date; note?: string | null; lines: { itemId: string; qty: number }[] };

/** Barang diserahkan ke driver: keluar dari gudang (KIRIM) atau titik (KEMBALI) ke lokasi driver */
export async function createHandover(input: HandoverInput, actor: Actor) {
  return prisma.$transaction((tx) => createHandoverTx(tx, input, actor));
}

/** Kirim bahan ke beberapa titik sekaligus: satu serah terima per titik, semua tersimpan atau tidak sama sekali */
export async function createHandovers(inputs: HandoverInput[], actor: Actor) {
  const list = inputs.filter((x) => x.lines.some((l) => l.itemId && l.qty > 0));
  if (!list.length) throw new BoronganError("Isi minimal satu barang beserta jumlahnya");
  return prisma.$transaction(async (tx) => {
    const out = [];
    for (const x of list) out.push(await createHandoverTx(tx, x, actor));
    return out;
  }, { timeout: 30000 });
}

async function createHandoverTx(tx: Tx, input: HandoverInput, actor: Actor) {
  const lines = input.lines.filter((l) => l.itemId && l.qty > 0);
  if (!lines.length) throw new BoronganError("Isi minimal satu barang beserta jumlahnya");
  {
    const point = await tx.boronganPoint.findUniqueOrThrow({ where: { id: input.pointId } });
    const drv = await driverLocation(tx);
    const date = input.date ?? new Date();
    const number = await nextNumber(tx, "SRT", date);
    const items = await tx.item.findMany({ where: { id: { in: lines.map((l) => l.itemId) } } });
    if (input.kind === "KEMBALI") {
      // Hasil tugas berdivisi masuk gudang lewat Penerimaan divisi (bukan kiriman hasil), agar stok tidak dobel
      const outs = await tx.pieceTask.findMany({ where: { divisionId: { not: null }, outputItemId: { in: items.map((i) => i.id) } }, select: { outputItemId: true } });
      if (outs.length) throw new BoronganError(`${items.filter((i) => outs.some((o) => o.outputItemId === i.id)).map((i) => i.name).join(", ")} diterima divisi lewat Penerimaan hasil borongan, bukan Kirim hasil ke gudang`);
    }
    const rows = [];
    for (const l of lines) {
      const item = items.find((i) => i.id === l.itemId);
      if (!item) throw new BoronganError("Barang tidak ditemukan");
      const warehouseId = await warehouseFor(tx, item.type);
      const from = input.kind === "KIRIM" ? warehouseId : point.locationId;
      await recordMovement(tx, { type: "TRANSFER", itemId: item.id, qty: l.qty, fromLocationId: from, toLocationId: drv, ref: `SRT:${number}`, note: `${HANDOVER_LABEL[input.kind]} ${point.name}`, date }, actor);
      rows.push({ itemId: item.id, qty: new Prisma.Decimal(l.qty), warehouseId });
    }
    const h = await tx.boronganHandover.create({
      data: { number, kind: input.kind, pointId: point.id, driverId: input.driverId || null, date, note: input.note ?? null, createdBy: actor.name, lines: { create: rows } },
    });
    await audit(actor, "SERAH_TERIMA_BORONGAN", "BoronganHandover", h.id, { number, kind: input.kind, point: point.code }, tx);
    return h;
  }
}

/**
 * Penerima mengonfirmasi: barang pindah dari driver ke titik (KIRIM) atau ke gudang (KEMBALI).
 * `divisionId`: kapten divisi boleh menerima kiriman hasil yang semua barangnya milik divisinya (mis. pot cat giftbox).
 */
export async function receiveHandover(id: string, actor: Actor, scope: Scope, opts: { divisionId?: string | null } = {}) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganHandover" WHERE id = ${id} FOR UPDATE`;
    const h = await tx.boronganHandover.findUniqueOrThrow({ where: { id }, include: { lines: true, point: true } });
    if (h.status !== "DIKIRIM") throw new BoronganError("Serah terima ini sudah diproses");
    // Bahan diterima koordinator titik; hasil diterima pengelola gudang
    if (h.kind === "KIRIM") {
      if (isSetoranOnly(scope)) throw new BoronganError("Bahan di titik diterima oleh koordinator titik");
      assertPoint(scope, h.pointId);
    } else if (!canWarehouse(scope)) {
      const items = opts.divisionId ? await tx.item.findMany({ where: { id: { in: h.lines.map((l) => l.itemId) } }, select: { divisionId: true } }) : [];
      if (!opts.divisionId || !items.length || items.some((i) => i.divisionId !== opts.divisionId)) throw new BoronganError("Hasil borongan diterima oleh pengelola gudang atau kapten divisi pemilik barang");
    }
    const drv = await driverLocation(tx);
    for (const l of h.lines) {
      const to = h.kind === "KIRIM" ? h.point.locationId : l.warehouseId;
      await recordMovement(tx, { type: "TRANSFER", itemId: l.itemId, qty: Number(l.qty), fromLocationId: drv, toLocationId: to, ref: `SRT:${h.number}`, note: `Diterima ${h.kind === "KIRIM" ? h.point.name : "gudang"}`, allowNegative: true }, actor);
    }
    await tx.boronganHandover.update({ where: { id }, data: { status: "DITERIMA", receivedAt: new Date(), receivedBy: actor.name } });
    await audit(actor, "SERAH_TERIMA_DITERIMA", "BoronganHandover", id, { number: h.number }, tx);
  });
}

/** Batalkan serah terima yang belum diterima: barang kembali ke asal */
export async function cancelHandover(id: string, actor: Actor, scope: Scope) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganHandover" WHERE id = ${id} FOR UPDATE`;
    const h = await tx.boronganHandover.findUniqueOrThrow({ where: { id }, include: { lines: true, point: true } });
    if (h.status !== "DIKIRIM") throw new BoronganError("Hanya serah terima yang belum diterima yang bisa dibatalkan");
    if (isSetoranOnly(scope) || (h.kind === "KIRIM" ? !canWarehouse(scope) : !canPoint(scope, h.pointId))) throw new BoronganError("Hanya pembuat serah terima yang bisa membatalkan");
    const drv = await driverLocation(tx);
    for (const l of h.lines) {
      const back = h.kind === "KIRIM" ? l.warehouseId : h.point.locationId;
      await recordMovement(tx, { type: "TRANSFER", itemId: l.itemId, qty: Number(l.qty), fromLocationId: drv, toLocationId: back, ref: `SRT:${h.number}`, note: "Serah terima dibatalkan", allowNegative: true }, actor);
    }
    await tx.boronganHandover.update({ where: { id }, data: { status: "DIBATALKAN" } });
    await audit(actor, "SERAH_TERIMA_DIBATALKAN", "BoronganHandover", id, { number: h.number }, tx);
  });
}

// ---------------- SETORAN HASIL ----------------

async function defaultStore(db: DB) {
  const s = await db.setting.findUnique({ where: { key: "default_store_id" } });
  if (!s) throw new BoronganError("Toko default belum diatur di Pengaturan");
  return s.value;
}

export type ResultInput = { pointId: string; workerId: string; taskId: string; date: Date; qty: number; reject?: number; note?: string | null };

/**
 * Catat hasil kerja satu pekerja:
 * - bahan per pcs (resep tugas) terpakai dari stok titik
 * - barang hasil bertambah di stok titik, nilai = bahan yang terpakai
 * - upah dicatat per pekerja/koordinator/driver, dibayar nanti lewat Bayar Upah
 */
export async function recordResult(input: ResultInput, actor: Actor, scope: Scope) {
  return prisma.$transaction((tx) => recordResultTx(tx, input, actor, scope));
}

/**
 * Setoran beberapa pekerja sekaligus dalam SATU transaksi: bila satu baris gagal
 * (mis. bahan tidak cukup), tidak ada setoran yang tersimpan sebagian.
 */
export async function recordResults(inputs: ResultInput[], actor: Actor, scope: Scope) {
  if (!inputs.length) throw new BoronganError("Isi jumlah hasil minimal satu pekerja");
  return prisma.$transaction(async (tx) => {
    const out = [];
    for (const input of inputs) out.push(await recordResultTx(tx, input, actor, scope));
    return out;
  }, { timeout: 30000 });
}

async function recordResultTx(tx: Tx, input: ResultInput, actor: Actor, scope: Scope) {
  // Setoran per pekerja (dasar upah) dicatat koordinator titik / pengelola; anggota divisi memakai Penerimaan per barang
  if (!scope.all && scope.division) throw new BoronganError("Setoran per pekerja dicatat koordinator titik. Divisi mencatat penerimaan per barang.");
  assertPoint(scope, input.pointId);
  const reject = input.reject ?? 0;
  if (!Number.isInteger(input.qty) || input.qty < 0 || !Number.isInteger(reject) || reject < 0) throw new BoronganError("Jumlah bagus dan reject harus bilangan bulat, tidak minus");
  if (input.qty + reject <= 0) throw new BoronganError("Isi jumlah bagus atau reject lebih dari 0");
  // Bahan terpakai untuk patung bagus + reject
  const made = input.qty + reject;
  {
    const point = await tx.boronganPoint.findUniqueOrThrow({ where: { id: input.pointId } });
    const worker = await tx.boronganPerson.findUniqueOrThrow({ where: { id: input.workerId } });
    if (worker.role !== "PEKERJA" || worker.pointId !== point.id || !worker.active) throw new BoronganError("Pekerja tidak terdaftar aktif di titik ini");
    const task = await tx.pieceTask.findUniqueOrThrow({ where: { id: input.taskId }, include: { inputs: { include: { item: true } }, outputItem: true } });
    // Pekerja yang sudah diatur jenis pekerjaannya hanya boleh disetor untuk tugas itu ("tidak salah kamar")
    if (worker.taskIds.length && !worker.taskIds.includes(task.id)) throw new BoronganError(`${worker.name} tidak mengerjakan ${task.name}`);
    if (!task.active) throw new BoronganError("Tugas ini sudah nonaktif");
    if (!canTask(scope, task.id)) throw new BoronganError(`Setoran ${task.name} dicatat oleh divisi lain`);
    const cfg = (await pointConfig(tx))[point.id];
    if (cfg?.tasks.length && !cfg.tasks.includes(task.id)) throw new BoronganError(`Tugas ${task.name} tidak dikerjakan di titik ${point.name}`);
    const split = { workerRate: Number(task.workerRate), coordinatorRate: Number(task.coordinatorRate), driverRate: Number(task.driverRate) };
    // Tanpa koordinator: bagian koordinator masuk ke pekerja (lihat postResultTx)
    const coordinator = await coordinatorFor(tx, worker);
    const driver = await tx.boronganPerson.findFirst({ where: { role: "DRIVER", active: true }, orderBy: { createdAt: "asc" } });
    if (split.driverRate > 0 && !driver) throw new BoronganError("Belum ada driver borongan aktif");
    // Hasil tidak boleh melebihi bahan yang sudah diterima titik (cegah upah dari hasil yang tidak didukung bahan)
    await tx.$queryRaw`SELECT id FROM "BoronganPoint" WHERE id = ${point.id} FOR UPDATE`;
    for (const inp of task.inputs) {
      const per = bomStockQty(inp.qty, inp.item);
      if (per <= 0) continue;
      const avail = await qtyAt(tx, inp.itemId, point.locationId);
      if (per * made > avail + 1e-6) {
        const cukup = Math.max(0, Math.floor((avail + 1e-6) / per));
        throw new BoronganError(`Bahan ${inp.item.name} di ${point.name} tinggal ${Number(avail.toFixed(3)).toLocaleString("id-ID")} ${inp.item.unit}, cukup untuk ${cukup} pcs (${worker.name} ${made} pcs termasuk reject). Kirim bahan dulu lewat serah terima.`);
      }
    }
    return postResultTx(tx, { point, worker, task, date: input.date, qty: input.qty, reject, coordinatorId: coordinator?.id ?? null, driverId: driver?.id ?? null, note: input.note ?? null }, actor);
  }
}

/**
 * Koordinator yang menerima bagian koordinator dari setoran pekerja: koordinator pilihan pekerja (aktif), selain itu
 * koordinator titiknya. null = tanpa koordinator → bagian koordinator dibayarkan ke pekerja (mis. Cat Plastik Rp15 utuh).
 */
export async function coordinatorFor(db: DB, worker: { coordinatorId?: string | null; pointId: string | null; noCoordinator?: boolean }) {
  if (worker.noCoordinator) return null;
  const point = worker.pointId ? await db.boronganPoint.findUnique({ where: { id: worker.pointId }, select: { noCoordinator: true } }) : null;
  if (worker.coordinatorId) {
    const c = await db.boronganPerson.findFirst({ where: { id: worker.coordinatorId, role: "KOORDINATOR", active: true }, include: { extraPoints: { select: { pointId: true } } } });
    if (c) {
      const covers = !!worker.pointId && coordinatorCovers(c, worker.pointId);
      // Koordinator yang memegang titik pekerja: fee hanya bila titik itu ber-fee (Mita di Beringin = pencatat, tanpa fee).
      // Koordinator titik lain (pilihan pekerja): fee bila ia memegang setidaknya satu titik ber-fee.
      if (covers ? !point?.noCoordinator : (await db.boronganPoint.count({ where: { id: { in: coordinatorPoints(c) }, noCoordinator: false } })) > 0) return c;
    }
  }
  // Titik disetel tanpa fee koordinator → upah koordinator ke pekerja
  if (!worker.pointId || point?.noCoordinator) return null;
  return db.boronganPerson.findFirst({ where: coordinatorsAt(worker.pointId), orderBy: { createdAt: "asc" } });
}

type ResultTask = Prisma.PieceTaskGetPayload<{ include: { inputs: { include: { item: true } }; outputItem: true } }>;
export type PostResult = {
  point: { id: string; code: string; name: string; locationId: string };
  worker: { id: string; name: string };
  task: ResultTask;
  date: Date;
  qty: number;
  reject: number;
  coordinatorId: string | null;
  driverId: string | null;
  note?: string | null;
  /** Alur kiriman: setoran dari pengambilan AMB; upah bisa ditahan */
  pickupId?: string | null;
  held?: boolean;
  /** Stok boleh minus (alur kiriman: penerimaan di lapangan tidak boleh tertahan karena selisih pencatatan bahan) */
  allowNegative?: boolean;
};

/**
 * Posting satu setoran (dasar upah pekerja/koordinator/driver sesuai tarif tugas saat ini):
 * - bahan per pcs (resep tugas) untuk bagus + reject terpakai dari stok titik
 * - barang hasil bertambah di stok titik, nilai = bahan yang terpakai; bahan reject dibebankan
 */
export async function postResultTx(tx: Tx, p: PostResult, actor: Actor) {
  const { point, worker, task, qty, reject } = p;
  const made = qty + reject;
  const number = await nextNumber(tx, "HSB", p.date);
  const r = await tx.boronganResult.create({
    data: {
      number, pointId: point.id, workerId: worker.id, coordinatorId: p.coordinatorId, driverId: p.driverId, taskId: task.id,
      date: p.date, qty, reject, ...ratesFor(task, p.coordinatorId),
      note: p.note ?? null, createdBy: actor.name, createdById: actor.id, pickupId: p.pickupId ?? null, held: p.held ?? false,
    },
  });
  const when = new Date(`${p.date.toISOString().slice(0, 10)}T05:00:00.000Z`);
  const outType: ItemType = task.outputItem?.type ?? "BARANG_DALAM_PROSES";
  const byType = new Map<ItemType, number>();
  let material = 0;
  const rejByType = new Map<ItemType, number>();
  for (const inp of task.inputs) {
    const q = bomStockQty(inp.qty, inp.item) * made;
    if (q <= 0) continue;
    await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: inp.itemId, qty: q, fromLocationId: point.locationId, ref: `HSB:${r.id}`, note: `${task.name} ${worker.name}${reject ? ` (reject ${reject})` : ""}`, date: when, allowNegative: p.allowNegative }, actor);
    const v = Math.round(q * Number(inp.item.avgCost));
    // Bagian bahan untuk patung reject dibebankan, sisanya menjadi nilai barang hasil
    const vRej = Math.round((v * reject) / made);
    material += v - vRej;
    byType.set(inp.item.type, (byType.get(inp.item.type) ?? 0) + v - vRej);
    if (vRej > 0) rejByType.set(inp.item.type, (rejByType.get(inp.item.type) ?? 0) + vRej);
  }
  // Upah borongan setoran ini (pekerja + koordinator → beban gaji produksi, driver → beban transport) ikut nilai barang hasil:
  // dibebankan saat dibayar (Bayar Upah / klaim), jadi di sini dikreditkan balik agar tidak terhitung dua kali
  const sh = resultShares(qty, Object.fromEntries(Object.entries(ratesFor(task, p.coordinatorId)).map(([k, v]) => [k, Number(v)])) as Split);
  const wageGaji = task.outputItemId && qty > 0 ? Math.round(sh.worker + sh.coordinator) : 0;
  const wageTransport = task.outputItemId && qty > 0 && p.driverId ? Math.round(sh.driver) : 0;
  const wage = wageGaji + wageTransport;
  if (task.outputItemId && qty > 0) {
    await recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: task.outputItemId, qty, toLocationId: point.locationId, unitCost: Math.round((material + wage) / qty), ref: `HSB:${r.id}`, note: `${task.name} ${worker.name}`, date: when }, actor);
  }
  // Nilai bahan pindah dari akun persediaan bahan ke akun persediaan barang hasil; bahan reject jadi beban
  const lines = [
    ...[...byType].filter(([t, v]) => t !== outType && v > 0).flatMap(([t, v]) => [{ accountCode: INVENTORY_COA[outType], debit: v }, { accountCode: INVENTORY_COA[t], credit: v }]),
    ...[...rejByType].flatMap(([t, v]) => [{ accountCode: COA.BEBAN_SELISIH_PERSEDIAAN, debit: v, memo: `Reject borongan ${reject} pcs` }, { accountCode: INVENTORY_COA[t], credit: v }]),
    ...(wage > 0 ? [{ accountCode: INVENTORY_COA[outType], debit: wage, memo: "Upah borongan masuk nilai barang hasil" }] : []),
    ...(wageGaji > 0 ? [{ accountCode: COA.BEBAN_GAJI_PRODUKSI, credit: wageGaji, memo: "Upah borongan dikapitalisasi ke persediaan" }] : []),
    ...(wageTransport > 0 ? [{ accountCode: COA.BEBAN_TRANSPORT, credit: wageTransport, memo: "Jatah driver dikapitalisasi ke persediaan" }] : []),
  ];
  if (lines.length) {
    await postJournal(tx, { date: when, storeId: await defaultStore(tx), description: `Borongan ${point.name}: ${task.name} × ${qty}${reject ? ` + reject ${reject}` : ""} (${worker.name})`, source: "BORONGAN", sourceId: r.id, actor, lines });
  }
  await audit(actor, "HASIL_BORONGAN", "BoronganResult", r.id, { number, point: point.code, worker: worker.name, task: task.code, qty, reject, pickupId: p.pickupId ?? undefined, ditahan: p.held || undefined }, tx);
  return r;
}

/** Tarif yang dicatat di setoran: tanpa koordinator, bagian koordinator ikut ke pekerja */
export function ratesFor(task: { workerRate: bigint; coordinatorRate: bigint; driverRate: bigint }, coordinatorId: string | null) {
  return coordinatorId
    ? { workerRate: task.workerRate, coordinatorRate: task.coordinatorRate, driverRate: task.driverRate }
    : { workerRate: task.workerRate + task.coordinatorRate, coordinatorRate: 0n, driverRate: task.driverRate };
}

/** Balik stok & jurnal satu setoran lalu hapus (setoran belum dibayar) */
export async function unpostResultTx(tx: Tx, id: string, actor: Actor, note: string) {
  await reverseMovementsByRef(tx, `HSB:${id}`, `BATAL-HSB:${id}`, note, actor);
  const journals = await tx.journal.findMany({ where: { source: "BORONGAN", sourceId: id, reversalOfId: null } });
  for (const j of journals) await reverseJournal(tx, j.id, new Date(), actor, note);
  await tx.boronganResult.delete({ where: { id } });
}

/** Hapus setoran yang belum dibayar: stok & jurnal dibalik */
export async function deleteResult(id: string, actor: Actor, scope: Scope) {
  return prisma.$transaction(async (tx) => {
    // Kunci baris: dua permintaan hapus bersamaan tidak boleh membalik stok dua kali
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "BoronganResult" WHERE id = ${id} FOR UPDATE`;
    if (!locked.length) throw new BoronganError("Setoran sudah dihapus");
    const r = await tx.boronganResult.findUniqueOrThrow({ where: { id }, include: { task: { select: { name: true } } } });
    assertPoint(scope, r.pointId);
    if (!canTask(scope, r.taskId)) throw new BoronganError(`Setoran ${r.task.name} milik divisi lain`);
    // Anggota divisi hanya membatalkan setoran yang ia catat sendiri; kapten semua setoran divisinya
    if (scope.division && !scope.division.captain && !scope.warehouse && r.createdById !== actor.id) throw new BoronganError("Anda hanya bisa membatalkan setoran yang Anda catat sendiri. Minta kapten divisi.");
    if (r.settlementId) throw new BoronganError("Upah setoran ini sudah dibayar, tidak bisa dihapus");
    if (r.pickupId) throw new BoronganError("Setoran ini dari pengambilan (AMB). Koreksi lewat penerimaan setoran.");
    await unpostResultTx(tx, id, actor, "Setoran borongan dihapus");
    await audit(actor, "HASIL_BORONGAN_DIHAPUS", "BoronganResult", id, { number: r.number, task: r.task.name, qty: r.qty, reject: r.reject, pencatat: r.createdBy }, tx);
  });
}

// ---------------- UPAH ----------------

export type PayLine = { personId: string; name: string; role: BoronganRole; qty: number; amount: number };

/** Rekap upah per orang dari daftar setoran */
export function payLines(results: { qty: number; workerRate: bigint; coordinatorRate: bigint; driverRate: bigint; worker: { id: string; name: string }; coordinator: { id: string; name: string } | null; driver: { id: string; name: string } | null }[]): PayLine[] {
  const m = new Map<string, PayLine>();
  const add = (p: { id: string; name: string } | null, role: BoronganRole, qty: number, amount: number) => {
    if (!p || amount <= 0) return;
    const k = `${role}:${p.id}`;
    const cur = m.get(k) ?? { personId: p.id, name: p.name, role, qty: 0, amount: 0 };
    cur.qty += qty;
    cur.amount += amount;
    m.set(k, cur);
  };
  for (const r of results) {
    const s = resultShares(r.qty, { workerRate: Number(r.workerRate), coordinatorRate: Number(r.coordinatorRate), driverRate: Number(r.driverRate) });
    add(r.worker, "PEKERJA", r.qty, s.worker);
    add(r.coordinator, "KOORDINATOR", r.qty, s.coordinator);
    add(r.driver, "DRIVER", r.qty, s.driver);
  }
  const order: BoronganRole[] = ["PEKERJA", "KOORDINATOR", "DRIVER"];
  return [...m.values()].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.name.localeCompare(b.name));
}

const resultPeople = { worker: true, coordinator: true, driver: true } as const;

export async function unpaidResults(db: DB, pointId: string, upTo?: Date) {
  // Upah yang ditahan (hitungan divisi kurang) tidak ikut dibayar sampai dicek
  // Setoran yang sudah masuk klaim upah dibayar lewat persetujuan klaim (bukan Bayar Upah per tanggal)
  return db.boronganResult.findMany({ where: { pointId, settlementId: null, held: false, claimId: null, ...(upTo ? { date: { lte: upTo } } : {}) }, include: { ...resultPeople, task: true }, orderBy: { date: "asc" } });
}

/**
 * Bayar upah satu titik sekaligus (pekerja, koordinator, dan jatah driver).
 * Jatah driver dibukukan sebagai beban transport borongan, terpisah dari Kompensasi Pengelola.
 */
export async function settlePoint(input: { pointId: string; upTo: Date; bankAccountId: string; date?: Date }, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganPoint" WHERE id = ${input.pointId} FOR UPDATE`;
    const results = await unpaidResults(tx, input.pointId, input.upTo);
    if (!results.length) throw new BoronganError("Tidak ada upah yang belum dibayar sampai tanggal itu");
    return settleResultsTx(tx, { pointId: input.pointId, upTo: input.upTo, bankAccountId: input.bankAccountId, date: input.date, results }, actor);
  });
}

/**
 * Bayar sekumpulan setoran satu titik (dipakai Bayar Upah per tanggal dan persetujuan klaim upah).
 * Upah pekerja & koordinator = beban gaji produksi; fee driver = beban transport borongan.
 */
export async function settleResultsTx(tx: Tx, input: { pointId: string; upTo: Date; bankAccountId: string; date?: Date; results: Awaited<ReturnType<typeof unpaidResults>>; label?: string }, actor: Actor) {
  const point = await tx.boronganPoint.findUniqueOrThrow({ where: { id: input.pointId } });
  const results = input.results;
  const lines = payLines(results);
  const driver = lines.filter((l) => l.role === "DRIVER").reduce((s, l) => s + l.amount, 0);
  const wages = lines.filter((l) => l.role !== "DRIVER").reduce((s, l) => s + l.amount, 0);
  const total = wages + driver;
  if (total <= 0) throw new BoronganError("Total upah Rp0, tidak ada yang dibayar");
  const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: input.bankAccountId } });
  const date = input.date ?? new Date();
  const number = await nextNumber(tx, "UPB", date);
  const st = await tx.boronganSettlement.create({ data: { number, pointId: point.id, date, upTo: input.upTo, bankAccountId: bank.id, total: BigInt(total), createdBy: actor.name } });
  const j = await postJournal(tx, {
    date,
    storeId: await defaultStore(tx),
    description: `Upah borongan ${point.name} ${input.label ?? `s.d. ${input.upTo.toISOString().slice(0, 10)}`} (${number})`,
    source: "BORONGAN",
    sourceId: st.id,
    actor,
    lines: [
      ...(wages > 0 ? [{ accountCode: COA.BEBAN_GAJI_PRODUKSI, debit: wages, memo: "Upah borongan pekerja & koordinator" }] : []),
      ...(driver > 0 ? [{ accountCode: COA.BEBAN_TRANSPORT, debit: driver, memo: "Jatah driver borongan" }] : []),
      { accountId: bank.coaAccountId, credit: total },
    ],
  });
  const paid = await tx.boronganSettlement.update({ where: { id: st.id }, data: { journalId: j.id } });
  // Hanya setoran yang belum dibayar (cegah bayar dobel bila dua permintaan bersamaan)
  const upd = await tx.boronganResult.updateMany({ where: { id: { in: results.map((r) => r.id) }, settlementId: null }, data: { settlementId: st.id } });
  if (upd.count !== results.length) throw new BoronganError("Sebagian setoran sudah dibayar. Muat ulang halaman.");
  await audit(actor, "UPAH_BORONGAN_DIBAYAR", "BoronganSettlement", st.id, { number, point: point.code, total }, tx);
  return paid;
}

/** Batalkan pembayaran upah satu titik: jurnal dibalik, setorannya kembali menjadi belum dibayar */
export async function cancelSettlement(id: string, reason: string, actor: Actor, now: Date = new Date()) {
  if (!reason?.trim() || reason.trim().length < 3) throw new BoronganError("Alasan pembatalan wajib diisi");
  return prisma.$transaction(async (tx) => {
    // Kunci per pembayaran: dua klik/permintaan bersamaan antre, yang kedua melihat "sudah dibatalkan" (tidak ada pembalik ganda)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`batal-bayar:${id}`}))`;
    await tx.$queryRaw`SELECT id FROM "BoronganSettlement" WHERE id = ${id} FOR UPDATE`;
    const st = await tx.boronganSettlement.findUniqueOrThrow({ where: { id } });
    if (st.cancelledAt) throw new BoronganError(`${st.number} sudah dibatalkan`);
    const date = await assertPeriodOpen(tx, st.date).then(() => st.date, () => now);
    if (st.journalId) await reverseJournal(tx, st.journalId, date, actor, `batal ${st.number} — ${reason.trim()}`.slice(0, 150));
    await tx.boronganResult.updateMany({ where: { settlementId: id }, data: { settlementId: null } });
    // Klaim upah yang dibayar lewat pembayaran ini kembali menunggu persetujuan
    await tx.boronganClaim.updateMany({ where: { settlementId: id }, data: { status: "MENUNGGU", settlementId: null, decidedAt: null, decidedBy: null } });
    const out = await tx.boronganSettlement.update({ where: { id }, data: { cancelledAt: now, cancelReason: reason.trim().slice(0, 300) } });
    await audit(actor, "UPAH_BORONGAN_DIBATALKAN", "BoronganSettlement", id, { number: st.number, reason }, tx);
    return out;
  });
}

/** Batalkan pembayaran upah dari Klaim Upah: hanya pemegang borongan.pay / borongan.manage; alasan wajib (jurnal pembalik, setoran & klaim kembali menunggu) */
export async function cancelPayment(id: string, reason: string, user: { id: string; name: string; can: (p: "borongan.pay" | "borongan.manage") => boolean }) {
  if (!user.can("borongan.pay") && !user.can("borongan.manage")) throw new BoronganError("Membatalkan pembayaran upah hanya oleh Finance / Owner / pengelola borongan");
  return cancelSettlement(id, reason, { id: user.id, name: user.name });
}

// ---------------- ORANG ----------------

export type PersonInput = { id?: string | null; name: string; phone?: string | null; role: BoronganRole; pointId?: string | null; active?: boolean; note?: string | null; taskIds?: string[]; coordinatorId?: string | null; /** Koordinator: titik tambahan (selain titik utama); undefined = tidak diubah */ extraPointIds?: string[] };

/** Koordinator hanya boleh menambah/mengubah pekerja di titiknya sendiri */
export async function savePerson(input: PersonInput, actor: Actor, scope: Scope) {
  const name = input.name.trim();
  if (!name) throw new BoronganError("Nama wajib diisi");
  const pointId = input.role === "DRIVER" ? null : input.pointId || null;
  if (input.role !== "DRIVER" && !pointId) throw new BoronganError("Pilih titik borongan");
  if (isSetoranOnly(scope)) throw new BoronganError("Data pekerja diatur pengelola borongan / koordinator titik");
  if (!scope.all) {
    if (input.role !== "PEKERJA") throw new BoronganError("Koordinator hanya bisa menambah pekerja");
    assertPoint(scope, pointId!);
  }
  // Jenis pekerjaan hanya untuk pekerja (koordinator/driver dibayar dari semua tugas titiknya)
  const taskIds = input.role === "PEKERJA" ? [...new Set(input.taskIds ?? [])] : [];
  if (taskIds.length) {
    const ok = await prisma.pieceTask.count({ where: { id: { in: taskIds } } });
    if (ok !== taskIds.length) throw new BoronganError("Jenis pekerjaan tidak dikenal");
  }
  // Koordinator pilihan (khusus pekerja): kosong = koordinator titik / tanpa koordinator
  // "-" = tanpa koordinator (bagian koordinator ke pekerja)
  let coordinatorId: string | null | undefined = undefined;
  const noCoordinator = input.coordinatorId === undefined ? undefined : input.role === "PEKERJA" && input.coordinatorId === "-";
  if (input.coordinatorId !== undefined) {
    coordinatorId = input.role === "PEKERJA" && input.coordinatorId && input.coordinatorId !== "-" ? input.coordinatorId : null;
    if (coordinatorId && !(await prisma.boronganPerson.count({ where: { id: coordinatorId, role: "KOORDINATOR", active: true } }))) throw new BoronganError("Koordinator tidak aktif");
  }
  const data = { name, phone: input.phone || null, role: input.role, pointId, active: input.active ?? true, note: input.note || null, ...(input.taskIds ? { taskIds } : {}), ...(coordinatorId !== undefined ? { coordinatorId, noCoordinator } : {}) };
  // Pekerja baru dari koordinator menunggu persetujuan pengelola (diaktifkan pengelola), agar upah tidak dibayar ke nama fiktif
  if (!scope.all && !input.id) data.active = false;
  if (input.id) {
    const cur = await prisma.boronganPerson.findUniqueOrThrow({ where: { id: input.id } });
    if (!scope.all && (cur.role !== "PEKERJA" || !canPoint(scope, cur.pointId ?? ""))) throw new BoronganError("Anda hanya bisa mengubah pekerja di titik Anda");
    if (!scope.all && !cur.active) data.active = false;
    const p = await prisma.boronganPerson.update({ where: { id: input.id }, data });
    // Akun login ikut nonaktif bila orangnya nonaktif atau perannya berubah (koordinator ↔ driver ↔ pekerja)
    if (cur.userId && (!data.active || data.role !== cur.role)) await prisma.user.update({ where: { id: cur.userId }, data: { active: false } });
    const extra = await syncExtraPoints(p, input, actor, scope);
    await audit(actor, "ORANG_BORONGAN_DIUBAH", "BoronganPerson", p.id, { ...data, ...(extra ? { titikTambahan: extra } : {}) });
    return p;
  }
  const p = await prisma.boronganPerson.create({ data });
  const extra = await syncExtraPoints(p, input, actor, scope);
  await audit(actor, "ORANG_BORONGAN_DITAMBAH", "BoronganPerson", p.id, { ...data, ...(extra ? { titikTambahan: extra } : {}) });
  return p;
}

/**
 * Titik tambahan koordinator (pengelola saja): disamakan dengan pilihan form. Bukan koordinator → semua titik tambahan dilepas.
 * Hanya penugasan (bukan data transaksi); riwayat setoran/klaim tetap per titik. Kembalikan daftar titik tambahan bila diubah.
 */
async function syncExtraPoints(p: { id: string; role: BoronganRole; pointId: string | null }, input: PersonInput, actor: Actor, scope: Scope) {
  if (input.extraPointIds === undefined && p.role === "KOORDINATOR") return null;
  if (!scope.all) return null;
  const want = p.role === "KOORDINATOR" ? [...new Set(input.extraPointIds ?? [])].filter((id) => id !== p.pointId) : [];
  if (want.length && (await prisma.boronganPoint.count({ where: { id: { in: want } } })) !== want.length) throw new BoronganError("Titik tambahan tidak dikenal");
  const cur = await prisma.boronganCoordinatorPoint.findMany({ where: { personId: p.id } });
  const drop = cur.filter((c) => !want.includes(c.pointId)).map((c) => c.id);
  const add = want.filter((id) => !cur.some((c) => c.pointId === id));
  if (!drop.length && !add.length) return null;
  if (drop.length) await prisma.boronganCoordinatorPoint.deleteMany({ where: { id: { in: drop } } });
  for (const pointId of add) await prisma.boronganCoordinatorPoint.create({ data: { personId: p.id, pointId, createdBy: actor.name } });
  return want;
}

/** Hapus orang; yang sudah punya riwayat setoran dinonaktifkan saja */
export async function removePerson(id: string, actor: Actor, scope: Scope) {
  if (isSetoranOnly(scope)) throw new BoronganError("Data pekerja diatur pengelola borongan / koordinator titik");
  const p = await prisma.boronganPerson.findUniqueOrThrow({ where: { id } });
  if (!scope.all && (p.role !== "PEKERJA" || !canPoint(scope, p.pointId ?? ""))) throw new BoronganError("Anda hanya bisa menghapus pekerja di titik Anda");
  const used = await prisma.boronganResult.count({ where: { OR: [{ workerId: id }, { coordinatorId: id }, { driverId: id }] } });
  if (used || p.userId) {
    await prisma.boronganPerson.update({ where: { id }, data: { active: false } });
    if (p.userId) await prisma.user.update({ where: { id: p.userId }, data: { active: false } });
    await audit(actor, "ORANG_BORONGAN_NONAKTIF", "BoronganPerson", id, { name: p.name });
    return "nonaktif" as const;
  }
  await prisma.boronganPerson.delete({ where: { id } });
  await audit(actor, "ORANG_BORONGAN_DIHAPUS", "BoronganPerson", id, { name: p.name });
  return "dihapus" as const;
}

/**
 * Sisa bahan di titik dalam satuan pcs per tugas: berapa patung (bagus + reject) lagi yang masih bisa disetor.
 * null = tugas tanpa resep bahan (tidak dibatasi).
 */
export async function pointCapacity(points: { id: string; locationId: string }[], taskIds: string[]) {
  const tasks = await prisma.pieceTask.findMany({ where: { id: { in: taskIds } }, include: { inputs: { include: { item: true } } } });
  const out: Record<string, Record<string, number | null>> = {};
  const cache = new Map<string, number>();
  for (const p of points) {
    out[p.id] = {};
    for (const t of tasks) {
      let cap: number | null = null;
      for (const inp of t.inputs) {
        const per = bomStockQty(inp.qty, inp.item);
        if (per <= 0) continue;
        const k = `${inp.itemId}:${p.locationId}`;
        if (!cache.has(k)) cache.set(k, await qtyAt(prisma, inp.itemId, p.locationId));
        const n = Math.max(0, Math.floor((cache.get(k)! + 1e-6) / per));
        cap = cap === null ? n : Math.min(cap, n);
      }
      out[p.id][t.id] = cap;
    }
  }
  return out;
}
