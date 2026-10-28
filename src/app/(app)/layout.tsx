import { requireUser } from "@/lib/auth";
import { NAV, BOTTOM_NAV } from "@/lib/nav";
import { FIELD_ROLES, ROLE_LABEL } from "@/lib/rbac";
import { Shell } from "@/components/Shell";
import { alertsFor } from "@/lib/alerts";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const nav = NAV.filter((n) => n.perms.some((p) => user.can(p))).map(({ href, label, icon }) => ({ href, label, icon }));
  const bottom = FIELD_ROLES.includes(user.role) ? BOTTOM_NAV.filter((n) => n.perms.some((p) => user.can(p))).map(({ href, label, icon }) => ({ href, label, icon })) : null;
  const alerts = await alertsFor(user.can, user.role === "KAPTEN_DIVISI" ? user.divisionId : null);
  return (
    <Shell nav={nav} bottomNav={bottom} user={{ name: user.name, role: ROLE_LABEL[user.role] }} env={process.env.APP_ENV || "development"} alerts={alerts.reduce((s, a) => s + a.count, 0)}>
      {children}
    </Shell>
  );
}
