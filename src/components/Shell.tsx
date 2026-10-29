"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";
import { Toaster } from "./Toaster";
import { ResponsiveTables } from "./ResponsiveTables";

type Item = { href: string; label: string; icon: string };

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
}

export function Shell({ nav, bottomNav, user, env, children, alerts }: { nav: Item[]; bottomNav: Item[]; user: { name: string; role: string }; env: string; children: React.ReactNode; alerts: number }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  // Slot terakhir diisi tombol "Menu" bila menu prioritas kurang dari 5
  const showMenuSlot = bottomNav.length < 5;
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
        <div className="theme-light no-print bg-amber-400 px-4 py-1 text-center text-xs font-semibold text-amber-950">LINGKUNGAN {env.toUpperCase()} — data uji, bukan produksi</div>
      )}
      <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-slate-200 bg-white/95 px-3 backdrop-blur sm:gap-3 sm:px-4">
        <button className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="Semua menu" onClick={() => setOpen(true)}>
          <Icon name="menu" />
        </button>
        <Link href="/" className="flex min-w-0 items-center gap-2 font-semibold text-slate-900">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-600 text-sm text-white">MG</span>
          <span className="hidden truncate sm:inline">Main Gypsum ERP</span>
        </Link>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <ThemeToggle />
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
            <div className="absolute inset-0 bg-slate-900/50" />
            <aside className="absolute left-0 top-0 flex h-full w-72 max-w-[85vw] flex-col overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-slate-900">{user.name}</div>
                  <div className="text-slate-500">{user.role}</div>
                </div>
                <button className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Tutup menu" onClick={() => setOpen(false)}>
                  ✕
                </button>
              </div>
              {side}
              <div className="mt-auto border-t border-slate-200 p-3">
                <ThemeToggle withLabel />
              </div>
            </aside>
          </div>
        )}
        <main className="min-w-0 flex-1 px-4 pb-24 pt-5 sm:px-6 lg:px-8 lg:pb-6">{children}</main>
      </div>
      <Toaster />
      <ResponsiveTables />
      <nav
        aria-label="Menu utama"
        style={{ gridTemplateColumns: `repeat(${bottomNav.length + (showMenuSlot ? 1 : 0)}, minmax(0,1fr))` }}
        className="no-print fixed inset-x-0 bottom-0 z-30 grid border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        {bottomNav.map((n) => {
          const active = isActive(path, n.href);
          return (
            <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} className={`flex min-w-0 flex-col items-center gap-0.5 px-1 pb-1.5 pt-2 text-[11px] font-medium ${active ? "text-brand-600" : "text-slate-500"}`}>
              <span className={`grid h-7 w-12 place-items-center rounded-full transition ${active ? "bg-brand-50" : ""}`}>
                <Icon name={n.icon} />
              </span>
              <span className="w-full truncate text-center">{n.label}</span>
            </Link>
          );
        })}
        {showMenuSlot && (
          <button type="button" onClick={() => setOpen(true)} className="flex min-w-0 flex-col items-center gap-0.5 px-1 pb-1.5 pt-2 text-[11px] font-medium text-slate-500">
            <span className="grid h-7 w-12 place-items-center rounded-full">
              <Icon name="grid" />
            </span>
            <span className="w-full truncate text-center">Menu</span>
          </button>
        )}
      </nav>
    </div>
  );
}
