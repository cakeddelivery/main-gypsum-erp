import { requireUser } from "@/lib/auth";
import { NAV, bottomNavFor, bottomNavWithReport } from "@/lib/nav";
import { reportDivision } from "@/lib/reportScope";
import { todayStr } from "@/lib/time";
import { ROLE_LABEL } from "@/lib/rbac";
import { Shell } from "@/components/Shell";
import { alertsFor } from "@/lib/alerts";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const nav = NAV.filter((n) => n.perms.some((p) => user.can(p))).map(({ href, label, icon }) => ({ href, label, icon }));
  // Tombol "+ Laporan shift" di tengah navigasi bawah (khusus yang boleh membuat laporan)
  const canReport = user.can("report.create");
  const bottom = canReport ? bottomNavWithReport(user.role, user.can) : bottomNavFor(user.role, user.can);
  const scope = canReport ? reportDivision(user) : null;
  const quickReport = canReport
    ? await Promise.all([
        prisma.division.findMany({ where: { active: true, ...(scope ? { id: scope } : {}) }, orderBy: { code: "asc" }, select: { id: true, name: true, shiftCount: true } }),
        prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, name: true, startTime: true, endTime: true } }),
      ]).then(([divisions, shifts]) => ({ today: todayStr(), divisions, shifts, auto: scope !== null }))
    : null;
  const [alerts, reads] = await Promise.all([alertsFor(user.can, user.role === "KAPTEN_DIVISI" ? user.divisionId : null), prisma.alertRead.findMany({ where: { userId: user.id } })]);
  // Dibaca = sudah dibuka/ditandai dan jumlahnya tidak bertambah sejak itu
  const items = alerts.map((a) => ({ ...a, read: (reads.find((r) => r.key === a.key)?.count ?? -1) >= a.count }));
  const division = user.employee?.division.name ?? null;
  return (
    <Shell nav={nav} bottomNav={bottom} user={{ name: user.name, username: user.username, role: ROLE_LABEL[user.role], division }} env={process.env.APP_ENV || "development"} alerts={items} quickReport={quickReport}>
      {children}
    </Shell>
  );
}
