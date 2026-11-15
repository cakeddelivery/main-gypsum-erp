"use server";
import { redirect } from "next/navigation";
import { action, str, optStr, int, bool } from "@/lib/action";
import { prisma } from "@/lib/db";
import { StockError } from "@/lib/stock";
import { MAX_PROOF_BYTES, MAX_PROOF_TEXT, readProof, saveProof } from "@/lib/storage";
import { jakartaDateTime, todayStr } from "@/lib/time";
import { mediaStore } from "@/lib/mediaStore";
import { compressImage } from "@/lib/imageCompress";
import { approveRefund, cancelComplaint, createComplaint, finishComplaint, payRefund, rejectComplaint, sendRefundProof, sendReplacement, type ComplaintInput } from "@/lib/complaints";

const PATHS = ["/retur", "/finance", "/akuntansi", "/stok"];
const day = (fd: FormData, k = "date") => jakartaDateTime(str(fd, k) || todayStr(), "12:00");
const num = (x: FormDataEntryValue) => Number(String(x).replace(/\D/g, "")) || 0;
const VIDEO = /^video\/(mp4|webm|quicktime|3gpp|x-matroska)$/;

/** Bukti dari pembeli: foto dikompres (tanpa EXIF/GPS), video disimpan apa adanya. Total maks 15 MB per kirim. */
async function saveEvidence(fd: FormData, complaintId: string, actor: string) {
  const files = fd.getAll("evidence").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > 10) throw new StockError("Bukti maksimal 10 file sekali kirim");
  if (files.reduce((s, f) => s + f.size, 0) > MAX_PROOF_BYTES) throw new StockError(`${MAX_PROOF_TEXT} (total semua file)`);
  for (const f of files) {
    const isImg = f.type.startsWith("image/");
    if (!isImg && !VIDEO.test(f.type)) throw new StockError("Bukti harus foto atau video");
    const raw = Buffer.from(await f.arrayBuffer());
    const c = isImg ? await compressImage(raw).catch(() => ({ buf: raw, changed: false })) : { buf: raw, changed: false };
    const mime = c.changed ? "image/jpeg" : f.type;
    const ext = c.changed ? "jpg" : (f.type.split("/")[1] ?? "bin").replace("jpeg", "jpg").replace("quicktime", "mov").replace("x-matroska", "mkv");
    const key = mediaStore.newKey("komplain", ext);
    await mediaStore.write(key, c.buf);
    await prisma.complaintMedia.create({ data: { complaintId, storageKey: key, mime, size: c.buf.length, createdBy: actor } });
  }
  return files.length;
}

function inputOf(fd: FormData): ComplaintInput {
  const skus = fd.getAll("labelSku").map(String);
  const names = fd.getAll("labelName").map(String);
  const items = fd.getAll("itemId").map(String);
  const qty = fd.getAll("qty").map(num);
  const send = fd.getAll("sendQty").map(num);
  let labelRead: ComplaintInput["labelRead"] = null;
  try {
    const x = JSON.parse(str(fd, "labelRead") || "null");
    if (x && typeof x === "object") labelRead = { source: String(x.source ?? "MANUAL").slice(0, 10), codes: Array.isArray(x.codes) ? x.codes.slice(0, 6).map((c: unknown) => String(c).slice(0, 40)) : [] };
  } catch {
    labelRead = null;
  }
  return {
    date: day(fd), marketplace: optStr(fd, "marketplace"), courier: optStr(fd, "courier"), trackingNo: optStr(fd, "trackingNo"), orderNo: optStr(fd, "orderNo"),
    city: optStr(fd, "city"), province: optStr(fd, "province"), issueType: str(fd, "issueType"), description: optStr(fd, "description"), solution: str(fd, "solution"),
    bundleNext: bool(fd, "bundleNext"), refundAmount: int(fd, "refundAmount"), payeeBank: optStr(fd, "payeeBank"), payeeAccount: optStr(fd, "payeeAccount"), payeeName: optStr(fd, "payeeName"),
    labelRead, lines: skus.map((s, i) => ({ labelSku: s, labelName: names[i], itemId: items[i] || null, qty: qty[i], sendQty: send[i] ?? 0 })),
  };
}

export const saveComplaint = action(
  "refund.request",
  async (fd, user) => {
    const c = await createComplaint(inputOf(fd), user);
    await saveEvidence(fd, c.id, user.name);
    redirect(`/retur/komplain/${c.id}`);
  },
  PATHS,
);

export const addEvidenceAction = action(
  ["refund.request", "refund.approve", "refund.pay"],
  async (fd, user) => {
    const n = await saveEvidence(fd, str(fd, "id"), user.name);
    if (!n) throw new StockError("Pilih file bukti dulu");
    return `${n} bukti ditambahkan`;
  },
  PATHS,
);

export const approveAction = action(
  "refund.approve",
  async (fd, user) => {
    const c = await approveRefund(str(fd, "id"), user);
    return `${c.number} disetujui, siap dibayar`;
  },
  PATHS,
);

export const rejectAction = action(
  "refund.approve",
  async (fd, user) => {
    const c = await rejectComplaint(str(fd, "id"), str(fd, "reason"), user);
    return `${c.number} ditolak`;
  },
  PATHS,
);

export const payAction = action(
  "refund.pay",
  async (fd, user) => {
    const file = fd.get("proof");
    if (!(file instanceof File) || !file.size) throw new StockError("Unggah bukti transfer refund");
    if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) throw new StockError("Bukti harus JPG, PNG, WEBP, atau PDF");
    if (file.size > MAX_PROOF_BYTES) throw new StockError(MAX_PROOF_TEXT);
    const proofPath = await saveProof(Buffer.from(await file.arrayBuffer()), file.type);
    const c = await payRefund(str(fd, "id"), { bankAccountId: str(fd, "bankAccountId"), date: day(fd), proofPath, proofMime: file.type }, user);
    const t = await sendRefundProof(c.id, readProof).catch(() => ({ sent: false, reason: "bot gagal" }));
    return `Refund ${c.number} dibayar & tercatat di Transaksi${t.sent ? "; bukti terkirim ke pengaju lewat bot" : `; bukti belum terkirim lewat bot (${"reason" in t ? t.reason : "gagal"})`}`;
  },
  PATHS,
);

export const resendProofAction = action(
  "refund.pay",
  async (fd) => {
    const t = await sendRefundProof(str(fd, "id"), readProof);
    if (!t.sent) throw new StockError(`Bukti belum terkirim: ${"reason" in t ? t.reason : "bot gagal"}`);
    return "Bukti terkirim ke pengaju";
  },
  PATHS,
);

export const sendReplacementAction = action(
  "refund.request",
  async (fd, user) => {
    const c = await sendReplacement(str(fd, "id"), user);
    return `Pengganti ${c.number} dikirim (stok keluar, beban garansi Rp ${Number(c.replacementValue).toLocaleString("id-ID")})`;
  },
  PATHS,
);

export const finishComplaintAction = action(
  ["refund.request", "refund.pay"],
  async (fd, user) => {
    const c = await finishComplaint(str(fd, "id"), user);
    return `${c.number} selesai`;
  },
  PATHS,
);

export const cancelComplaintAction = action(
  "refund.approve",
  async (fd, user) => {
    const c = await cancelComplaint(str(fd, "id"), str(fd, "reason"), user);
    return `${c.number} dibatalkan`;
  },
  PATHS,
);
