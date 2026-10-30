import Link from "next/link";
import { LinkPending } from "./LinkPending";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold capitalize text-slate-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="no-print flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, actions, className = "" }: { title?: string; children: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          {title && <h2 className="text-sm font-semibold capitalize text-slate-700">{title}</h2>}
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = "slate", href }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "slate" | "green" | "red" | "amber" | "blue"; href?: string }) {
  const tones = { slate: "text-slate-900", green: "text-emerald-600", red: "text-rose-600", amber: "text-amber-600", blue: "text-brand-600" };
  const body = (
    <div className="card h-full p-4 transition hover:border-brand-200">
      <p className="text-xs font-medium capitalize text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums sm:text-xl ${tones[tone]}`}>{value}</p>
      {hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

const BADGE: Record<string, string> = {
  gray: "bg-slate-100 text-slate-700",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  red: "bg-rose-50 text-rose-700 ring-rose-200",
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
  blue: "bg-brand-50 text-brand-700 ring-brand-100",
  purple: "bg-violet-50 text-violet-700 ring-violet-200",
};
export function Badge({ children, tone = "gray" }: { children: React.ReactNode; tone?: keyof typeof BADGE }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-transparent ${BADGE[tone]}`}>{children}</span>;
}

export function Empty({ title = "Belum ada data", hint, action }: { title?: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <div className="mb-2 text-3xl text-slate-300">◌</div>
      <p className="font-medium text-slate-600">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-slate-400">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Field({ label, children, hint, className = "" }: { label: string; children: React.ReactNode; hint?: string; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

export function Tabs({ tabs, current }: { tabs: { href: string; label: string; count?: number; key: string }[]; current: string }) {
  return (
    <div className="no-print -mx-1 mb-4 flex gap-1 overflow-x-auto pb-1">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${t.key === current ? "bg-brand-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
        >
          {t.label}
          {t.count !== undefined && <span className={`ml-1.5 rounded-full px-1.5 text-xs ${t.key === current ? "bg-brand-800" : "bg-slate-100"}`}>{t.count}</span>}
          <LinkPending className="ml-1.5 align-[-2px]" />
        </Link>
      ))}
    </div>
  );
}

/** Form filter berbasis query string (GET) — tetap jalan tanpa JavaScript */
export function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <form className="no-print keep-cols mb-4 grid grid-cols-2 items-end gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:flex sm:flex-wrap" method="get">
      {children}
      <button className="btn-secondary col-span-2" type="submit">
        Terapkan
      </button>
    </form>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{message}</div>;
}
