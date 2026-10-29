import { headers } from "next/headers";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { telegramConfigured } from "@/lib/telegram";
import { API_SCOPES } from "@/lib/apiAuth";
import { fmtDateTime } from "@/lib/time";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { ActionForm, Submit } from "@/components/ActionForm";
import { createApiClient, revokeApiClient, saveIdentity, testRecap } from "../actions";
import { Paged } from "@/components/Paged";

export const metadata = { title: "Telegram & Hermes" };

export default async function TelegramPage() {
  await requirePerm("telegram.manage"); // khusus Owner
  const h = await headers();
  const base = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const [idents, users, clients, logs] = await Promise.all([
    prisma.telegramIdentity.findMany({ include: { user: true }, orderBy: { telegramName: "asc" } }),
    prisma.user.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.apiClient.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.notificationLog.findMany({ orderBy: { at: "desc" }, take: 50 }),
  ]);
  const form = (x?: (typeof idents)[number]) => (
    <ModalForm action={saveIdentity} className="grid grid-cols-2 gap-3">
      {x && <input type="hidden" name="id" value={x.id} />}
      <Field label="ID pengguna Telegram"><input name="telegramUserId" defaultValue={x?.telegramUserId} inputMode="numeric" className="input" required /></Field>
      <Field label="Nama Telegram"><input name="telegramName" defaultValue={x?.telegramName ?? ""} className="input" /></Field>
      <Field label="Dipetakan ke pengguna sistem" className="col-span-2"><select name="userId" defaultValue={x?.userId} className="input">{users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}</select></Field>
      <Field label="Chat ID (otomatis saat /start)"><input name="chatId" defaultValue={x?.chatId ?? ""} className="input" /></Field>
      <div className="space-y-1 text-sm">
        <label className="flex gap-2"><input type="checkbox" name="canSubmit" defaultChecked={x?.canSubmit ?? true} /> Boleh kirim transaksi</label>
        <label className="flex gap-2"><input type="checkbox" name="canConfirm" defaultChecked={x?.canConfirm} /> Boleh konfirmasi pembukuan</label>
        <label className="flex gap-2"><input type="checkbox" name="receiveRecap" defaultChecked={x?.receiveRecap} /> Terima rekap 07.00 & laporan</label>
        {x && <label className="flex gap-2"><input type="checkbox" name="active" defaultChecked={x.active} /> Aktif</label>}
      </div>
      <p className="col-span-2 text-xs text-slate-500">Konfirmasi pembukuan via Telegram tetap mensyaratkan pengguna terpetakan memiliki izin “Setujui & bukukan transaksi”.</p>
      <div className="col-span-2"><Submit>Simpan</Submit></div>
    </ModalForm>
  );
  return (
    <div className="space-y-5">
      <PageHeader title="Telegram & Hermes AI" subtitle="Menu pengelolaan bot — khusus Owner" />
      <Card title="Status integrasi">
        <ul className="space-y-1 text-sm">
          <li>Bot token: {telegramConfigured() ? <Badge tone="green">Terpasang</Badge> : <Badge tone="red">Belum diatur (TELEGRAM_BOT_TOKEN)</Badge>}</li>
          <li>Hermes forwarding: {process.env.HERMES_WEBHOOK_URL ? <Badge tone="green">{process.env.HERMES_WEBHOOK_URL}</Badge> : <Badge>Tidak aktif — memakai ekstraksi lokal</Badge>}</li>
          <li>Webhook Telegram: <code className="rounded bg-slate-100 px-1 text-xs">{base}/api/telegram/webhook</code> (header secret: TELEGRAM_WEBHOOK_SECRET)</li>
          <li>Finance API untuk Hermes: <code className="rounded bg-slate-100 px-1 text-xs">{base}/api/v1</code> — lihat <a className="link" href="/api/v1" target="_blank">dokumentasi singkat</a></li>
          <li>Alur: Telegram Bot → Hermes AI Agent → Finance API (/api/v1, hanya draft) → konfirmasi manusia → pembukuan.</li>
        </ul>
        <ActionForm action={testRecap} className="mt-3"><Submit className="btn-secondary btn-sm">Kirim rekap harian sekarang (uji)</Submit></ActionForm>
      </Card>
      <Card title="Identitas Telegram berizin" actions={<Modal trigger="+ Identitas" triggerClass="btn-primary btn-sm" title="Identitas Telegram">{form()}</Modal>}>
        <div className="overflow-x-auto">
          <Paged><table className="tbl">
            <thead><tr><th>ID Telegram</th><th>Nama</th><th>Pengguna</th><th>Kirim</th><th>Konfirmasi</th><th>Rekap</th><th>Status</th><th /></tr></thead>
            <tbody>{idents.map((x) => <tr key={x.id}><td className="font-mono text-xs">{x.telegramUserId}</td><td>{x.telegramName}</td><td>{x.user.name}</td><td>{x.canSubmit ? "✓" : ""}</td><td>{x.canConfirm ? "✓" : ""}</td><td>{x.receiveRecap ? "✓" : ""}</td><td>{x.active ? <Badge tone="green">Aktif</Badge> : <Badge>Nonaktif</Badge>}</td><td><Modal trigger="Ubah" triggerClass="btn-secondary btn-sm" title="Ubah identitas">{form(x)}</Modal></td></tr>)}</tbody>
          </table></Paged>
        </div>
      </Card>
      <Card title="API key Hermes (Finance API /api/v1)" actions={
        <Modal trigger="+ API key" triggerClass="btn-primary btn-sm" title="API key baru">
        <ActionForm action={createApiClient} persist className="space-y-3">
          <Field label="Nama klien"><input name="name" defaultValue="Hermes AI Agent" className="input" required /></Field>
          <div className="text-sm">{Object.entries(API_SCOPES).map(([k, v]) => <label key={k} className="flex gap-2"><input type="checkbox" name="scopes" value={k} defaultChecked /> <code className="text-xs">{k}</code> — {v}</label>)}</div>
          <Submit>Buat API key</Submit>
        </ActionForm>
        </Modal>
      }>
        <p className="mb-3 text-xs text-slate-500">Tidak ada scope untuk membukukan atau mengakses database: Hermes hanya bisa membuat/mengubah draft dan membaca data referensi.</p>
        <Paged><table className="tbl">
          <thead><tr><th>Nama</th><th>Prefix</th><th>Scope</th><th>Dipakai terakhir</th><th>Status</th><th /></tr></thead>
          <tbody>{clients.map((c) => <tr key={c.id}><td>{c.name}</td><td className="font-mono text-xs">mgk_{c.keyPrefix}_…</td><td className="text-xs">{c.scopes}</td><td className="text-xs">{fmtDateTime(c.lastUsedAt)}</td><td>{c.active ? <Badge tone="green">Aktif</Badge> : <Badge tone="red">Dicabut</Badge>}</td><td>{c.active && <ActionForm action={revokeApiClient} confirm="Cabut API key ini?"><input type="hidden" name="id" value={c.id} /><Submit className="btn-danger btn-sm">Cabut</Submit></ActionForm>}</td></tr>)}</tbody>
        </table></Paged>
      </Card>
      <Card title="Log pengiriman & kesalahan">
        <div className="overflow-x-auto">
          <Paged><table className="tbl">
            <thead><tr><th>Waktu</th><th>Kanal</th><th>Jenis</th><th>Tujuan</th><th>Status</th><th>Kesalahan</th></tr></thead>
            <tbody>{logs.map((l) => <tr key={l.id}><td>{fmtDateTime(l.at)}</td><td>{l.channel}</td><td>{l.type}</td><td className="font-mono text-xs">{l.target}</td><td><Badge tone={l.status === "TERKIRIM" || l.status === "SELESAI" ? "green" : "red"}>{l.status}</Badge></td><td className="max-w-xs truncate text-xs text-rose-600">{l.error}</td></tr>)}</tbody>
          </table></Paged>
        </div>
      </Card>
    </div>
  );
}
