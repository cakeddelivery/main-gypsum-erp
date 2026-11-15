"use server";
import { redirect } from "next/navigation";
import { action, str, optStr, int } from "@/lib/action";
import { assertPerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { StockError } from "@/lib/stock";
import { MAX_PROOF_BYTES, MAX_PROOF_TEXT, saveProof } from "@/lib/storage";
import { jakartaDateTime, todayStr } from "@/lib/time";
import { mediaStore } from "@/lib/mediaStore";
import { compressImage } from "@/lib/imageCompress";
import { readReturnLabel } from "@/lib/returnLabelRead";
import { matchItem, type LabelRead } from "@/lib/returnLabel";
import { cancelReturn, claimPaid, claimRejected, createReturn, finishReturn, inspectReturn, returnCatalog, skuMaps, submitClaim, updateReturn, type ReturnInput } from "@/lib/returns";

const PATHS = ["/retur", "/stok", "/finance", "/akuntansi"];
const day = (fd: FormData, k = "date") => jakartaDateTime(str(fd, k) || todayStr(), "12:00");

/**
 * Baca foto label resi (dipanggil langsung dari form, bukan disimpan). Barcode sudah dibaca di HP; foto ini untuk
 * kolom lain (marketplace, kurir, no. pesanan, kota/kab, provinsi, produk). Foto TIDAK disimpan.
 */
export async function readLabelAction(fd: FormData): Promise<{ ok: boolean; error?: string; source?: string; read?: LabelRead; matches?: (string | null)[] }> {
  try {
    await assertPerm("retur.manage", "refund.request");
    const file = fd.get("label");
    if (!(file instanceof File) || !file.size) return { ok: false, error: "Foto label belum dipilih" };
    if (!file.type.startsWith("image/")) return { ok: false, error: "Foto label harus berupa gambar" };
    if (file.size > MAX_PROOF_BYTES) return { ok: false, error: MAX_PROOF_TEXT };
    const r = await readReturnLabel(Buffer.from(await file.arrayBuffer()), file.type);
    const [catalog, maps] = await Promise.all([returnCatalog(), skuMaps()]);
    const matches = r.read.lines.map((l) => matchItem(l, catalog, maps)?.itemId ?? null);
    return { ok: true, source: r.source, read: r.read, matches, ...(r.error ? { error: r.error } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "Gagal membaca label" };
  }
}

function inputOf(fd: FormData): ReturnInput {
  const skus = fd.getAll("labelSku").map(String);
  const vars = fd.getAll("labelVariation").map(String);
  const names = fd.getAll("labelName").map(String);
  const qty = fd.getAll("qty").map((x) => Number(String(x).replace(/\./g, "")) || 0);
  const items = fd.getAll("itemId").map(String);
  let labelRead: ReturnInput["labelRead"] = null;
  try {
    const x = JSON.parse(str(fd, "labelRead") || "null");
    // Hanya cara baca & isi barcode (tanpa data pribadi)
    if (x && typeof x === "object") labelRead = { source: String(x.source ?? "MANUAL").slice(0, 10), codes: Array.isArray(x.codes) ? x.codes.slice(0, 6).map((c: unknown) => String(c).slice(0, 40)) : [] };
  } catch {
    labelRead = null;
  }
  return {
    receivedAt: day(fd),
    marketplace: optStr(fd, "marketplace"),
    courier: optStr(fd, "courier"),
    trackingNo: str(fd, "trackingNo"),
    orderNo: optStr(fd, "orderNo"),
    city: optStr(fd, "city"),
    province: optStr(fd, "province"),
    reason: optStr(fd, "reason"),
    note: optStr(fd, "note"),
    labelRead,
    lines: skus.map((s, i) => ({ labelSku: s, labelVariation: vars[i], labelName: names[i], qty: qty[i], itemId: items[i] || null })),
  };
}

export const saveReturn = action(
  "retur.manage",
  async (fd, user) => {
    const r = await createReturn(inputOf(fd), user);
    redirect(`/retur/${r.id}?rekam=1`);
  },
  PATHS,
);

export const editReturn = action(
  "retur.manage",
  async (fd, user) => {
    const r = await updateReturn(str(fd, "id"), inputOf(fd), user);
    return `${r.number} diperbarui`;
  },
  PATHS,
);

/** Foto kerusakan per barang (dikompres, tanpa EXIF/GPS) */
async function saveDamagePhotos(fd: FormData, returnId: string, actor: string) {
  const files = [...fd.entries()].filter(([k, v]) => k.startsWith("damage:") && v instanceof File && v.size > 0) as [string, File][];
  if (files.length > 20) throw new StockError("Foto kerusakan maksimal 20");
  for (const [k, f] of files) {
    if (!f.type.startsWith("image/")) throw new StockError("Foto kerusakan harus berupa gambar");
    if (f.size > MAX_PROOF_BYTES) throw new StockError(MAX_PROOF_TEXT);
    const raw = Buffer.from(await f.arrayBuffer());
    const c = await compressImage(raw).catch(() => ({ buf: raw, changed: false }));
    const key = mediaStore.newKey("retur", c.changed ? "jpg" : (f.type.split("/")[1] ?? "jpg").replace("jpeg", "jpg"));
    await mediaStore.write(key, c.changed ? c.buf : raw);
    await prisma.returnMedia.create({ data: { returnId, lineId: k.slice(7) || null, kind: "DAMAGE", status: "READY", storageKey: key, mime: c.changed ? "image/jpeg" : f.type, size: (c.changed ? c.buf : raw).length, createdBy: actor } });
  }
  return files.length;
}

export const inspectAction = action(
  "retur.manage",
  async (fd, user) => {
    const id = str(fd, "id");
    const lineIds = fd.getAll("lineId").map(String);
    const good = fd.getAll("goodQty").map((x) => Number(x) || 0);
    const bad = fd.getAll("damagedQty").map((x) => Number(x) || 0);
    const notes = fd.getAll("lineNote").map(String);
    const r = await inspectReturn(id, lineIds.map((lineId, i) => ({ lineId, goodQty: good[i], damagedQty: bad[i], note: notes[i] })), user);
    const photos = await saveDamagePhotos(fd, id, user.name);
    return `${r.number} diperiksa: barang baik Rp ${Number(r.goodValue).toLocaleString("id-ID")} kembali ke stok, kerugian Rp ${Number(r.lossValue).toLocaleString("id-ID")}${photos ? `, ${photos} foto` : ""}`;
  },
  PATHS,
);

export const claimAction = action(
  "retur.manage",
  async (fd, user) => {
    const r = await submitClaim(str(fd, "id"), int(fd, "amount"), optStr(fd, "note"), user);
    return `Klaim ${r.number} diajukan`;
  },
  PATHS,
);

export const claimPaidAction = action(
  ["retur.manage"],
  async (fd, user) => {
    if (!user.can("finance.create")) throw new StockError("Klaim cair dicatat oleh Finance / Admin Marketplace (izin input transaksi)");
    const file = fd.get("proof");
    let proof: { proofPath: string | null; proofMime: string | null } = { proofPath: null, proofMime: null };
    if (file instanceof File && file.size > 0) {
      if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) throw new StockError("Bukti harus JPG, PNG, WEBP, atau PDF");
      if (file.size > MAX_PROOF_BYTES) throw new StockError(MAX_PROOF_TEXT);
      proof = { proofPath: await saveProof(Buffer.from(await file.arrayBuffer()), file.type), proofMime: file.type };
    }
    const r = await claimPaid(str(fd, "id"), { amount: int(fd, "amount"), bankAccountId: str(fd, "bankAccountId"), date: day(fd), ...proof }, user);
    return `Klaim ${r.number} cair, tercatat sebagai pemasukan di Transaksi`;
  },
  PATHS,
);

export const claimRejectedAction = action(
  "retur.manage",
  async (fd, user) => {
    const r = await claimRejected(str(fd, "id"), str(fd, "reason"), user);
    return `Klaim ${r.number} ditandai ditolak`;
  },
  PATHS,
);

export const finishAction = action(
  "retur.manage",
  async (fd, user) => {
    const r = await finishReturn(str(fd, "id"), user);
    return `${r.number} selesai`;
  },
  PATHS,
);

export const cancelAction = action(
  "retur.manage",
  async (fd, user) => {
    const r = await cancelReturn(str(fd, "id"), str(fd, "reason"), user);
    return `${r.number} dibatalkan`;
  },
  PATHS,
);
