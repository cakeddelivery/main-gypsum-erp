import { requireUser } from "@/lib/auth";
import { NAV, bottomNavFor } from "@/lib/nav";
import { ROLE_LABEL } from "@/lib/rbac";
import { Shell } from "@/components/Shell";
import { alertsFor } from "@/lib/alerts";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const nav = NAV.filter((n) => n.perms.some((p) => user.can(p))).map(({ href, label, icon }) => ({ href, label, icon }));
  const bottom = bottomNavFor(user.role, user.can);
  const alerts = await alertsFor(user.can, user.role === "KAPTEN_DIVISI" ? user.divisionId : null);
  return (
    <Shell nav={nav} bottomNav={bottom} user={{ name: user.name, role: ROLE_LABEL[user.role] }} env={process.env.APP_ENV || "development"} alerts={alerts.reduce((s, a) => s + a.count, 0)}>
      {children}
    </Shell>
  );
}
