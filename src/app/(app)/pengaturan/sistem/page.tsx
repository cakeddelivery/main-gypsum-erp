import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { telegramConfigured } from "@/lib/telegram";
import { Badge, Card, PageHeader } from "@/components/ui";

export const metadata = { title: "Sistem" };

export default async function SistemPage() {
  await requirePerm("settings.manage", "users.manage", "telegram.manage");
  const t0 = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  const dbMs = Date.now() - t0;
  const [jobs, migrations] = await Promise.all([
    prisma.setting.findMany({ where: { key: { startsWith: "job_" } } }),
    prisma.$queryRaw<{ migration_name: string; finished_at: Date }[]>`SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5`,
  ]);
  const env = process.env.APP_ENV || "development";
  return (
    <div className="space-y-5">
      <PageHeader title="Sistem" subtitle="Lingkungan, monitoring, backup & pemulihan" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Status">
          <ul className="space-y-1 text-sm">
            <li>Lingkungan: <Badge tone={env === "production" ? "green" : "amber"}>{env}</Badge></li>
            <li>Database: <Badge tone="green">OK · {dbMs} ms</Badge></li>
            <li>Telegram bot: {telegramConfigured() ? <Badge tone="green">Aktif</Badge> : <Badge tone="red">Belum diatur</Badge>}</li>
            <li>Health check: <code className="rounded bg-slate-100 px-1 text-xs">GET /api/health</code></li>
            {jobs.map((j) => <li key={j.key}>Job {j.key.replace("job_", "").replace("_last", "")}: terakhir {j.value}</li>)}
          </ul>
        </Card>
        <Card title="Migrasi database terbaru">
          <ul className="space-y-1 font-mono text-xs">{migrations.map((m) => <li key={m.migration_name}>{m.migration_name}</li>)}</ul>
        </Card>
        <Card title="Backup & pemulihan" className="lg:col-span-2">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
            <li>Backup harian: <code className="text-xs">npm run backup</code> (pg_dump terkompresi ke folder <code className="text-xs">backups/</code>, simpan 14 hari). Jadwalkan via cron server.</li>
            <li>Pemulihan: <code className="text-xs">npm run restore -- backups/&lt;file&gt;.dump</code> ke database tujuan (uji dulu di staging).</li>
            <li>File bukti privat ada di <code className="text-xs">STORAGE_DIR</code> — ikut di-backup (rsync / snapshot volume).</li>
            <li>Staging & production memakai database, AUTH_SECRET, dan bot Telegram terpisah (lihat README).</li>
          </ol>
        </Card>
      </div>
    </div>
  );
}
