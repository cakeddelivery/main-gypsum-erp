"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "./Icon";
import { Toaster } from "./Toaster";

type Item = { href: string; label: string; icon: string };

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
}

export function Shell({ nav, bottomNav, user, env, children, alerts }: { nav: Item[]; bottomNav: Item[] | null; user: { name: string; role: string }; env: string; children: React.ReactNode; alerts: number }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const side = (
    <nav className="flex flex-col gap-0.5 p-3">
      {nav.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          onClick={() => setOpen(false)}
          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${isActive(path, n.href) ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100"}`}
        >
          <Icon name={n.icon} />
          {n.label}
        </Link>
      ))}
    </nav>
  );
  return (
    <div className="min-h-screen">
      {env !== "production" && (
        <div className="no-print bg-amber-400 px-4 py-1 text-center text-xs font-semibold text-amber-950">LINGKUNGAN {env.toUpperCase()} — data uji, bukan produksi</div>
      )}
      <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur">
        {!bottomNav && (
          <button className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="Menu" onClick={() => setOpen(true)}>
            <Icon name="menu" />
          </button>
        )}
        <Link href="/" className="flex items-center gap-2 font-semibold text-slate-900">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm text-white">MG</span>
          <span className="hidden sm:inline">Main Gypsum ERP</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/#notifikasi" className="relative rounded-lg p-1.5 text-slate-600 hover:bg-slate-100" aria-label="Notifikasi">
            <Icon name="bell" />
            {alerts > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-rose-600 px-1.5 text-[10px] font-bold text-white">{alerts > 99 ? "99+" : alerts}</span>}
          </Link>
          <div className="hidden text-right text-xs leading-tight sm:block">
            <div className="font-medium text-slate-800">{user.name}</div>
            <div className="text-slate-500">{user.role}</div>
          </div>
          <form action="/logout" method="post">
            <button className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100" aria-label="Keluar" title="Keluar">
              <Icon name="logout" />
            </button>
          </form>
        </div>
      </header>
      <div className="flex">
        <aside className="no-print sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 overflow-y-auto border-r border-slate-200 bg-white lg:block">{side}</aside>
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOpen(false)}>
            <div className="absolute inset-0 bg-slate-900/40" />
            <aside className="absolute left-0 top-0 h-full w-72 overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="border-b px-4 py-3 text-sm">
                <div className="font-semibold">{user.name}</div>
                <div className="text-slate-500">{user.role}</div>
              </div>
              {side}
            </aside>
          </div>
        )}
        <main className={`min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8 ${bottomNav ? "pb-24 lg:pb-6" : ""}`}>{children}</main>
      </div>
      <Toaster />
      {bottomNav && (
        <nav className="no-print fixed inset-x-0 bottom-0 z-30 grid border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden" style={{ gridTemplateColumns: `repeat(${bottomNav.length}, minmax(0,1fr))` }}>
          {bottomNav.map((n) => (
            <Link key={n.href} href={n.href} className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${isActive(path, n.href) ? "text-brand-600" : "text-slate-500"}`}>
              <Icon name={n.icon} />
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
