import nodemailer, { type Transporter } from "nodemailer";

/**
 * Kirim email lewat SMTP (mis. Gmail + App Password).
 * Env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.
 */
export type MailMessage = { to: string; subject: string; html: string; text: string };
export type MailSender = (m: MailMessage) => Promise<void>;

export function mailConfigured(env: NodeJS.ProcessEnv = process.env) {
  return !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

let transport: Transporter | null = null;

export const sendMail: MailSender = async (m) => {
  if (!mailConfigured()) throw new Error("SMTP belum diatur");
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  const from = process.env.MAIL_FROM || `Main Gypsum ERP <${process.env.SMTP_USER}>`;
  await transport.sendMail({ from, to: m.to, subject: m.subject, html: m.html, text: m.text });
};

/** URL publik aplikasi (production / staging) dari APP_URL, tanpa garis miring di akhir. */
export function appUrl(fallback?: string) {
  return (process.env.APP_URL || fallback || "https://erp.maingypsum.shop").replace(/\/+$/, "");
}

