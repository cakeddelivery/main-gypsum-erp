import { requireUser } from "@/lib/auth";
import { NAV, bottomNavFor } from "@/lib/nav";
import { ROLE_LABEL } from "@/lib/rbac";
import { Shell } from "@/components/Shell";
import { alertsFor } from "@/lib/alerts";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const nav = NAV.filter((n) => n.perms.some((p) => user.can(p))).map(({ href, label, icon }) => ({ href, label, icon }));
  const bottom = bottomNavFor(user.role, user.can);
  const [alerts, reads] = await Promise.all([alertsFor(user.can, user.role === "KAPTEN_DIVISI" ? user.divisionId : null), prisma.alertRead.findMany({ where: { userId: user.id } })]);
  // Dibaca = sudah dibuka/ditandai dan jumlahnya tidak bertambah sejak itu
  const items = alerts.map((a) => ({ ...a, read: (reads.find((r) => r.key === a.key)?.count ?? -1) >= a.count }));
  const division = user.employee?.division.name ?? null;
  return (
    <Shell nav={nav} bottomNav={bottom} user={{ name: user.name, username: user.username, role: ROLE_LABEL[user.role], division }} env={process.env.APP_ENV || "development"} alerts={items}>
      {children}
    </Shell>
  );
}
