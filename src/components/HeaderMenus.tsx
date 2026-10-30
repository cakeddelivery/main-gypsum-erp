"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { markAlertsRead } from "@/app/(app)/profil/actions";
import { initials } from "@/lib/initials";
import { Icon } from "./Icon";
import { startNavProgress } from "./NavProgress";

export type HeaderAlert = { key: string; label: string; count: number; href: string; tone: "red" | "amber" | "blue"; read: boolean };

/** Popover kecil di bawah tombol header; tertutup saat ketuk di luar, Esc, atau pindah halaman */
function Popover({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: React.ReactNode }) {
  const path = usePathname();
  useEffect(() => onClose(), [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div role="dialog" aria-label={label} className="anim-pop origin-top-right fixed inset-x-2 top-14 z-50 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96">
        {children}
      </div>
    </>
  );
}

const DOT = { red: "bg-rose-500", amber: "bg-amber-500", blue: "bg-brand-500" };

/** Lonceng notifikasi: popup dengan tab Belum dibaca / Sudah dibaca */
export function NotificationBell({ alerts }: { alerts: HeaderAlert[] }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"unread" | "read">("unread");
  const [pending, start] = useTransition();
  const router = useRouter();
  const unread = alerts.filter((a) => !a.read);
  const read = alerts.filter((a) => a.read);
  const list = tab === "unread" ? unread : read;
  const mark = (items: HeaderAlert[]) =>
    start(async () => {
      await markAlertsRead(items.map(({ key, count }) => ({ key, count })));
      router.refresh();
    });
  const markAll = () => mark(unread);
  const openAlert = (a: HeaderAlert) => {
    setOpen(false);
    if (!a.read) mark([a]);
    startNavProgress();
    router.push(a.href);
  };
  return (
    <div className="relative">
      <button type="button" className="relative rounded-lg p-1.5 text-slate-600 hover:bg-slate-100" aria-label={`Notifikasi, ${unread.length} belum dibaca`} aria-expanded={open} onClick={() => { setTab(unread.length ? "unread" : "read"); setOpen((o) => !o); }}>
        <Icon name="bell" />
        {unread.length > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-rose-600 px-1.5 text-[10px] font-bold text-white">{unread.length > 99 ? "99+" : unread.length}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Notifikasi">
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 pt-3">
          <div role="tablist" className="flex gap-4 text-sm font-medium">
            {([["unread", "Belum dibaca", unread.length], ["read", "Sudah dibaca", read.length]] as const).map(([k, l, n]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px border-b-2 pb-2.5 ${tab === k ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
                {l} <span className={`ml-1 rounded-full px-1.5 text-xs ${tab === k ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-600"}`}>{n}</span>
              </button>
            ))}
          </div>
          {tab === "unread" && unread.length > 0 && <button type="button" disabled={pending} onClick={markAll} className="pb-2.5 text-xs font-medium text-brand-600 hover:underline disabled:opacity-60">Tandai semua dibaca</button>}
        </div>
        <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto">
          {list.length === 0 && <li className="px-4 py-8 text-center text-sm text-slate-500">{tab === "unread" ? "✓ Tidak ada notifikasi baru" : "Belum ada notifikasi yang dibaca"}</li>}
          {list.map((a) => (
            <li key={a.key}>
              <button type="button" onClick={() => openAlert(a)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-slate-50">
                <span className={`h-2 w-2 shrink-0 rounded-full ${a.read ? "bg-slate-300" : DOT[a.tone]}`} />
                <span className={`min-w-0 flex-1 ${a.read ? "text-slate-500" : "font-medium text-slate-800"}`}>{a.label}</span>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-700">{a.count}</span>
              </button>
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  );
}

/** Ikon profil: info pengguna yang login + menu Profil dan Keluar */
export function ProfileMenu({ user }: { user: { name: string; username: string; role: string; division?: string | null } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" className="flex items-center gap-2 rounded-lg p-1 hover:bg-slate-100" aria-label="Profil" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-600 text-xs font-bold text-white">{initials(user.name)}</span>
        <span className="hidden text-left text-xs leading-tight sm:block">
          <span className="block font-medium text-slate-800">{user.name}</span>
          <span className="block text-slate-500">{user.role}</span>
        </span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Profil">
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-600 text-sm font-bold text-white">{initials(user.name)}</span>
          <div className="min-w-0">
            <div className="truncate font-semibold text-slate-900">{user.name}</div>
            <div className="truncate text-sm text-slate-500">@{user.username} · {user.role}{user.division ? ` · ${user.division}` : ""}</div>
          </div>
        </div>
        <div className="p-2">
          <Link href="/profil" onClick={() => setOpen(false)} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
            <Icon name="user" /> Profil
          </Link>
          <form action="/logout" method="post">
            <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-rose-600 hover:bg-rose-50">
              <Icon name="logout" /> Keluar
            </button>
          </form>
        </div>
      </Popover>
    </div>
  );
}
