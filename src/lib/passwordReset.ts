import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";
import { audit } from "./audit";
import { appUrl, mailConfigured, sendMail, type MailSender } from "./mail";
import { clearLoginBlocks, passwordChangeData } from "./loginGuard";

/**
 * Lupa password lewat email.
 * - Token acak 32 byte dikirim di link; DB hanya menyimpan hash SHA-256 (token mentah tidak pernah disimpan).
 * - Sekali pakai, berlaku 30 menit. Token baru membatalkan token lama akun yang sama.
 * - Pesan di layar selalu sama, baik akun ada maupun tidak.
 * - Batas permintaan per IP dan per akun (username/email yang diketik).
 */
export const RESET_TTL_MIN = 30;
export const RESET_IP_MAX = 10; // per jam per IP
export const RESET_ID_MAX = 3; // per jam per username/email
const WINDOW_MIN = 60;
const MIN = 60_000;

export const RESET_SENT_MESSAGE =
  "Bila username/email terdaftar dan memiliki email, link reset password sudah dikirim. Periksa kotak masuk (atau folder Spam). Link berlaku 30 menit.";
export const RESET_LIMIT_MESSAGE = "Terlalu banyak permintaan reset password. Coba lagi beberapa saat lagi.";
export const RESET_NO_SMTP_MESSAGE = "Hubungi Owner untuk reset password.";

export function hashResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function newResetToken() {
  return randomBytes(32).toString("base64url");
}

export function resetEmail(name: string, link: string, base: string) {
  const subject = "Reset password Main Gypsum ERP";
  const text = [
    `Halo ${name},`,
    "",
    "Kami menerima permintaan reset password akun Main Gypsum ERP Anda.",
    "Buka link berikut untuk membuat password baru (berlaku 30 menit, hanya bisa dipakai sekali):",
    link,
    "",
    "Bila Anda tidak meminta reset password, abaikan email ini. Password Anda tidak berubah.",
    "",
    "Main Gypsum · Sahabat Kreatif Anak",
  ].join("\n");
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const html = `<!doctype html><html lang="id"><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#1e293b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td align="center" style="padding-bottom:16px"><img src="${esc(base)}/brand/logo-main-gypsum.png" alt="Main Gypsum" width="88" height="88" style="border-radius:12px;display:block">
<div style="margin-top:10px;font-size:18px;font-weight:bold">Main Gypsum ERP</div><div style="font-size:12px;color:#64748b">Sahabat Kreatif Anak</div></td></tr>
<tr><td style="font-size:15px;line-height:1.6">
<p>Halo <b>${esc(name)}</b>,</p>
<p>Kami menerima permintaan reset password akun Main Gypsum ERP Anda. Tekan tombol di bawah untuk membuat password baru.</p>
<p style="text-align:center;margin:24px 0"><a href="${esc(link)}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">Buat password baru</a></p>
<p style="font-size:13px;color:#475569">Link berlaku <b>30 menit</b> dan hanya bisa dipakai sekali. Bila tombol tidak bisa ditekan, salin link ini ke browser:<br><span style="word-break:break-all">${esc(link)}</span></p>
<p style="font-size:13px;color:#475569">Bila Anda tidak meminta reset password, abaikan email ini. Password Anda tidak berubah.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

export type ResetRequestResult = { ok: true; message: string } | { ok: false; error: string };

type Opts = { now?: Date; send?: MailSender; configured?: boolean; baseUrl?: string };

/** Proses "Lupa password". Tidak pernah membocorkan apakah akun ada. */
export async function requestPasswordReset(identifierRaw: string, ip: string, opts: Opts = {}): Promise<ResetRequestResult> {
  const now = opts.now ?? new Date();
  const configured = opts.configured ?? mailConfigured();
  if (!configured) return { ok: false, error: RESET_NO_SMTP_MESSAGE };
  const identifier = identifierRaw.trim().toLowerCase().slice(0, 120);
  if (!identifier) return { ok: false, error: "Isi username atau email" };

  const since = new Date(now.getTime() - WINDOW_MIN * MIN);
  await prisma.passwordResetRequest.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 2 * 24 * 60 * MIN) } } });
  const [ipCount, idCount] = await Promise.all([
    prisma.passwordResetRequest.count({ where: { ip, createdAt: { gte: since, lte: now } } }),
    prisma.passwordResetRequest.count({ where: { identifier, createdAt: { gte: since, lte: now } } }),
  ]);
  if (ipCount >= RESET_IP_MAX || idCount >= RESET_ID_MAX) return { ok: false, error: RESET_LIMIT_MESSAGE };
  await prisma.passwordResetRequest.create({ data: { ip, identifier, createdAt: now } });

  const user = await prisma.user.findFirst({ where: identifier.includes("@") ? { email: identifier } : { username: identifier } });
  await audit(user ? { actorId: user.id, actorName: user.name } : null, "RESET_PASSWORD_DIMINTA", "User", user?.id ?? null, {
    ip,
    dikirim: !!(user && user.active && user.email),
    ...(user ? {} : { identifier }),
  });
  if (!user || !user.active || !user.email) return { ok: true, message: RESET_SENT_MESSAGE };

  const token = newResetToken();
  await prisma.$transaction([
    // token lama yang belum dipakai dibatalkan (hanya link terbaru yang berlaku)
    prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } }),
    prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashResetToken(token), expiresAt: new Date(now.getTime() + RESET_TTL_MIN * MIN), ip, createdAt: now },
    }),
  ]);
  const base = (opts.baseUrl ?? appUrl()).replace(/\/+$/, "");
  const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;
  const mail = resetEmail(user.name, link, base);
  // Tidak ditunggu: waktu respons sama dengan akun yang tidak ada / tanpa email
  void (opts.send ?? sendMail)({ to: user.email, ...mail }).catch((e) => console.error("[reset-password] gagal kirim email:", e?.message ?? e));
  return { ok: true, message: RESET_SENT_MESSAGE };
}

/** Cek token reset masih berlaku (untuk menampilkan form). */
export async function findValidResetToken(token: string, now = new Date()) {
  if (!token || token.length > 200) return null;
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashResetToken(token) }, include: { user: true } });
  if (!row || row.usedAt || row.expiresAt <= now || !row.user.active) return null;
  return row;
}

export const RESET_INVALID = "Link reset tidak berlaku atau sudah kedaluwarsa. Minta link baru dari halaman Lupa password.";

/** Pakai token: ganti password, naikkan sessionVersion (semua sesi keluar), buka kunci login. */
export async function resetPasswordWithToken(token: string, passwordHash: string, ip: string, now = new Date()): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const row = await findValidResetToken(token, now);
  if (!row) return { ok: false, error: RESET_INVALID };
  const done = await prisma.$transaction(async (tx) => {
    // tandai terpakai secara atomik: bila dua permintaan bersamaan, hanya satu yang menang
    const used = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (used.count !== 1) return false;
    await tx.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: now } });
    await tx.user.update({ where: { id: row.userId }, data: passwordChangeData(passwordHash) });
    return true;
  });
  if (!done) return { ok: false, error: RESET_INVALID };
  await clearLoginBlocks(row.user.username);
  await audit({ actorId: row.user.id, actorName: row.user.name }, "RESET_PASSWORD_BERHASIL", "User", row.user.id, { ip, lewat: "email" });
  return { ok: true, userId: row.userId };
}
