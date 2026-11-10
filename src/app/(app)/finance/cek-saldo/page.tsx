import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { fmtDate, fmtDateTime } from "@/lib/time";
import { balanceCheckRecipients, RECIPIENT_SETTING } from "@/lib/balanceCheck";
import { Badge, Empty, PageHeader, Tabs } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import type { BalanceCheckStatus, Prisma } from "@prisma/client";
import { setRecipients } from "./actions";

export const metadata = { title: "Cek Saldo Harian" };

const LABEL: Record<BalanceCheckStatus, string> = { MENUNGGU: "Belum dicek", SESUAI: "Sesuai", TIDAK_SESUAI: "Tidak sesuai" };
const TONE: Record<BalanceCheckStatus, "gray" | "green" | "red"> = { MENUNGGU: "gray", SESUAI: "green", TIDAK_SESUAI: "red" };
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${idr(Math.abs(n))}`;

export default async function CekSaldoPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requirePerm("finance.approve");
  const sp = await searchParams;
  const status = (["MENUNGGU", "SESUAI", "TIDAK_SESUAI"] as const).find((s) => s === sp.status);
  const where: Prisma.BalanceCheckWhereInput = status ? { status } : {};
  const [rows, counts, recipients, setting, linked] = await Promise.all([
    prisma.balanceCheck.findMany({ where, include: { bankAccount: true }, orderBy: [{ date: "desc" }, { bankAccount: { code: "asc" } }], take: 300 }),
    prisma.balanceCheck.groupBy({ by: ["status"], _count: true }),
    balanceCheckRecipients(),
    prisma.setting.findUnique({ where: { key: RECIPIENT_SETTING } }),
    user.can("settings.manage") ? prisma.telegramIdentity.findMany({ where: { active: true, user: { active: true } }, include: { user: true }, orderBy: { user: { name: "asc" } } }) : [],
  ]);
  const count = (s?: BalanceCheckStatus) => (s ? counts.find((c) => c.status === s)?._count ?? 0 : counts.reduce((t, c) => t + c._count, 0));
  const chosen = new Set(recipients.map((r) => r.userId));
  return (
    <div>
      <PageHeader
        title="Cek saldo harian"
        subtitle={<>Setiap pagi 05.00 WIB bot mengirim saldo akhir rekening (kemarin 23.59) ke <b>{recipients.map((r) => r.user.name).join(", ") || "— (belum ada yang tertaut Telegram)"}</b>{setting ? "" : " (bawaan)"} untuk dicocokkan dengan aplikasi bank. Pengingat 12.00 bila belum dijawab.</>}
        actions={<>
          <Link href="/finance" className="btn-secondary">← Transaksi</Link>
          {user.can("settings.manage") && (
            <Modal trigger="Atur penerima" triggerClass="btn-secondary" title="Penerima cek saldo pagi">
              <ModalForm action={setRecipients} className="space-y-3">
                <p className="text-sm text-slate-600">Pilih pengguna yang menerima cek saldo di Telegram. Kosongkan semua = bawaan (Jojo). Owner selalu ikut menerima daftar saldo.</p>
                <div className="space-y-1">
                  {linked.map((i) => (
                    <label key={i.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="userId" value={i.userId} defaultChecked={!!setting && chosen.has(i.userId)} />
                      {i.user.name} <span className="text-xs text-slate-500">@{i.user.username}{i.chatId ? "" : " · belum /start bot"}</span>
                    </label>
                  ))}
                </div>
                <Submit>Simpan</Submit>
              </ModalForm>
            </Modal>
          )}
        </>}
      />
      <Tabs current={status ?? "ALL"} tabs={[{ key: "ALL", label: "Semua", href: "/finance/cek-saldo?status=ALL", count: count() }, ...(["TIDAK_SESUAI", "MENUNGGU", "SESUAI"] as const).map((s) => ({ key: s, label: LABEL[s], href: `/finance/cek-saldo?status=${s}`, count: count(s) }))]} />
      {rows.length === 0 ? <Empty title="Belum ada pengecekan" hint="Pengecekan pertama dikirim bot besok pagi pukul 05.00 WIB." /> : (
        <div className="table-wrap">
          <Paged><table className="tbl">
            <thead><tr><th>Tanggal</th><th>Rekening</th><th className="num">Saldo buku 23.59</th><th className="num">Saldo buku saat cek</th><th className="num">Saldo bank</th><th className="num">Selisih</th><th>Status</th><th>Lampiran</th><th>Dicek oleh</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const att = (r.attachments as { path: string; mime: string }[] | null) ?? [];
                return (
                  <tr key={r.id}>
                    <td>{fmtDate(r.date)}</td>
                    <td>{r.bankAccount.name}</td>
                    <td className="num">{idr(r.bookBalance)}</td>
                    <td className="num">{idr(r.currentBalance)}</td>
                    <td className="num">{r.bankBalance != null ? idr(r.bankBalance) : "—"}</td>
                    <td className={`num font-medium ${r.diff ? "text-rose-600" : ""}`}>{r.diff != null ? signed(Number(r.diff)) : "—"}</td>
                    <td><Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>{r.status === "TIDAK_SESUAI" && !r.done && <> <Badge tone="amber">Belum selesai</Badge></>}</td>
                    <td>{att.length ? att.map((a, k) => <a key={k} className="link mr-2 whitespace-nowrap" href={`/api/files/balance-check/${r.id}/${k}`} target="_blank" rel="noreferrer">📎 {a.mime === "application/pdf" ? "PDF" : "Foto"} {k + 1}</a>) : "—"}</td>
                    <td className="whitespace-nowrap">{r.checkedByName ? <>{r.checkedByName}<div className="text-xs text-slate-500">{fmtDateTime(r.checkedAt)}</div></> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></Paged>
        </div>
      )}
    </div>
  );
}
