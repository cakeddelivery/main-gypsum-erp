"use client";
import { useEffect } from "react";
import { capitalizeWords, choiceMode, matchesQuery, shouldCapitalize, type ChoiceMode } from "@/lib/choice";

/**
 * Mengubah setiap <select> di aplikasi tanpa menyentuh form-nya satu per satu:
 * ≤ 3 opsi jadi tombol pilihan, > 3 opsi jadi dropdown dengan kotak cari (kotak cari hanya bila opsi > 6).
 * Atribut `data-dropdown` memaksa bentuk dropdown walau opsinya sedikit (mis. di dalam tabel).
 * <select> aslinya tetap ada (disembunyikan) sehingga nilai form, validasi `required`,
 * dan onChange React tetap berjalan. Lewati dengan atribut `data-plain`.
 *
 * Panel dropdown memakai posisi fixed (tidak terpotong tabel yang bisa digeser / popup), lebarnya sama
 * dengan kolom pemicu dan menempel tepat di bawahnya (atau di atasnya bila ruang di bawah kurang).
 * Kotak cari tidak pernah otomatis aktif; di komputer, mengetik saat dropdown terbuka langsung mencari.
 */
type State = { host: HTMLDivElement; mode: ChoiceMode; sig: string; close?: () => void };
const states = new Map<HTMLSelectElement, State>();
const valueSetter = typeof window !== "undefined" ? Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set : undefined;

function setValue(sel: HTMLSelectElement, v: string) {
  if (sel.value === v) return;
  valueSetter?.call(sel, v);
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Layar sentuh (HP/tablet, termasuk laptop layar sentuh) */
const isTouch = () => typeof window !== "undefined" && (window.matchMedia?.("(any-pointer: coarse)").matches || navigator.maxTouchPoints > 0);
/** Kotak cari hanya ditampilkan bila pilihannya banyak */
export const SEARCH_MIN_OPTIONS = 7;

const label = (o: HTMLOptionElement) => o.text.trim() || "—";
/** Opsi petunjuk seperti "— pilih supplier —" (value kosong & disabled) tidak dihitung/ditampilkan sebagai pilihan */
const isPlaceholder = (o: HTMLOptionElement) => o.value === "" && o.disabled;
const choices = (sel: HTMLSelectElement) => Array.from(sel.options).filter((o) => !isPlaceholder(o));
const signature = (sel: HTMLSelectElement) => `${sel.disabled}|${Array.from(sel.options).map((o) => `${o.value}\u0001${o.text}\u0001${o.disabled}`).join("\u0002")}`;

/** Kelas tata letak grid (col-span-*, sm:col-span-*, …) dari <select> asli ikut ke pengganti, agar lebarnya di grid tetap sama */
const layoutClasses = (sel: HTMLSelectElement) =>
  Array.from(sel.classList)
    .filter((c) => /^([a-z0-9]+:)*(col-span|col-start|col-end|row-span|order|self|justify-self)-/.test(c))
    .join(" ");

function renderButtons(sel: HTMLSelectElement, host: HTMLDivElement) {
  host.className = `choice-seg ${layoutClasses(sel)}`.trim();
  host.setAttribute("role", "radiogroup");
  host.replaceChildren(
    ...choices(sel).map((o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label(o);
      b.dataset.value = o.value;
      b.setAttribute("role", "radio");
      b.disabled = sel.disabled || o.disabled;
      b.addEventListener("click", () => setValue(sel, o.value));
      return b;
    }),
  );
}

/** Lebar minimum panel (px) untuk kolom yang sangat sempit */
const MIN_PANEL = 140;

/**
 * Posisi panel (fixed, relatif layar): selebar kolom pemicu, tepat di bawahnya; ke atas bila ruang di bawah kurang.
 * Tidak meluber keluar layar (di HP panel yang meluber membuat halaman ikut melebar).
 */
export function panelBox(r: { left: number; top: number; bottom: number; width: number }, vw: number, vh: number) {
  const width = Math.min(Math.max(r.width, MIN_PANEL), vw - 16);
  const left = Math.min(Math.max(8, r.left), vw - 8 - width);
  const below = vh - r.bottom;
  const up = below < 260 && r.top > below;
  const room = (up ? r.top : below) - 12;
  return { width, left, up, top: up ? null : r.bottom + 2, bottom: up ? vh - r.top + 2 : null, room };
}

function renderSearch(sel: HTMLSelectElement, host: HTMLDivElement, st: State) {
  host.className = `choice-search ${layoutClasses(sel)}`.trim();
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "input choice-trigger";
  trigger.disabled = sel.disabled;
  trigger.setAttribute("aria-haspopup", "listbox");
  const text = document.createElement("span");
  text.className = "choice-text";
  const caret = document.createElement("span");
  caret.className = "choice-caret";
  caret.textContent = "▾";
  trigger.append(text, caret);

  const panel = document.createElement("div");
  panel.className = "choice-panel";
  panel.hidden = true;
  const search = document.createElement("input");
  search.type = "search";
  search.className = "input";
  search.placeholder = "Cari…";
  search.setAttribute("enterkeyhint", "done");
  search.hidden = choices(sel).length < SEARCH_MIN_OPTIONS;
  // Kelas .input memberi display sendiri, jadi atribut hidden saja tidak cukup
  if (search.hidden) search.style.display = "none";
  const list = document.createElement("ul");
  list.className = "choice-list";
  list.setAttribute("role", "listbox");
  panel.append(search, list);

  const fill = () => {
    const q = search.value;
    const rows = choices(sel).filter((o) => matchesQuery(label(o), q));
    list.replaceChildren(
      ...(rows.length
        ? rows.map((o) => {
            const li = document.createElement("li");
            li.textContent = label(o);
            li.setAttribute("role", "option");
            li.dataset.value = o.value;
            if (o.disabled) li.setAttribute("aria-disabled", "true");
            if (o.value === sel.value) li.setAttribute("aria-selected", "true");
            li.addEventListener("mousedown", (e) => e.preventDefault());
            li.addEventListener("click", () => {
              if (o.disabled) return;
              setValue(sel, o.value);
              close();
            });
            return li;
          })
        : [Object.assign(document.createElement("li"), { textContent: "Tidak ditemukan", className: "choice-empty" })]),
    );
  };
  const onOutside = (e: Event) => {
    if (!host.contains(e.target as Node)) close();
  };
  const position = () => {
    if (panel.hidden) return;
    const vw = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth);
    const b = panelBox(trigger.getBoundingClientRect(), vw, window.innerHeight);
    panel.style.width = `${b.width}px`;
    panel.style.left = `${b.left}px`;
    panel.style.top = b.top == null ? "" : `${b.top}px`;
    panel.style.bottom = b.bottom == null ? "" : `${b.bottom}px`;
    host.classList.toggle("choice-up", b.up);
    const searchH = search.hidden ? 16 : 64;
    if (!panel.contains(document.activeElement)) list.style.maxHeight = `${Math.max(120, Math.min(240, b.room - searchH))}px`;
  };
  // Halaman / tabel / popup digeser: panel ikut kolomnya (kecuali yang digeser daftar pilihan itu sendiri)
  const onScroll = (e: Event) => {
    if (e.target instanceof Node && panel.contains(e.target)) return;
    position();
  };
  const open = () => {
    search.value = "";
    fill();
    panel.hidden = false;
    position();
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", fit);
    list.querySelector("[aria-selected]")?.scrollIntoView({ block: "nearest" });
  };
  const close = () => {
    if (panel.hidden) return;
    if (panel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    list.style.maxHeight = "";
    window.visualViewport?.removeEventListener("resize", fit);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", position);
    // Animasi tutup: salinan panel memudar sebentar, panel asli langsung disembunyikan (logika tetap sama)
    if (panel.parentNode && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const ghost = panel.cloneNode(true) as HTMLElement;
      ghost.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
      ghost.removeAttribute("id");
      ghost.setAttribute("aria-hidden", "true");
      ghost.classList.add("choice-panel-out");
      panel.after(ghost);
      window.setTimeout(() => ghost.remove(), 130);
    }
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
  };
  st.close = close;
  trigger.addEventListener("click", () => (panel.hidden ? open() : close()));
  // Keyboard di komputer: panah bawah membuka; mengetik huruf saat terbuka langsung ke kotak cari
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && panel.hidden) {
      e.preventDefault();
      open();
    } else if (e.key === "Escape") close();
    else if (!panel.hidden && !search.hidden && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) search.focus();
  });
  search.addEventListener("input", fill);
  // HP: saat kotak cari diketuk dan keyboard muncul, geser kolom ke atas layar dan batasi tinggi daftar
  // agar pilihan tidak tertutup keyboard
  const fit = () => {
    if (panel.hidden || !isTouch()) return;
    const vv = window.visualViewport;
    const viewH = vv ? vv.height + vv.offsetTop : window.innerHeight;
    const top = list.getBoundingClientRect().top;
    list.style.maxHeight = `${Math.max(120, Math.floor(viewH - top - 12))}px`;
  };
  search.addEventListener("focus", () => {
    if (!isTouch()) return;
    host.classList.remove("choice-up");
    setTimeout(() => {
      trigger.scrollIntoView({ block: "start", behavior: "smooth" });
      setTimeout(fit, 350);
    }, 250);
  });

  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      trigger.focus();
    } else if (e.key === "Enter") {
      // Enter memilih hasil pertama, bukan mengirim form
      e.preventDefault();
      const first = list.querySelector<HTMLLIElement>("li[data-value]:not([aria-disabled])");
      if (first) first.click();
    }
  });
  host.replaceChildren(trigger, panel);
}

function sync(sel: HTMLSelectElement, st: State) {
  if (st.mode === "buttons") {
    for (const b of Array.from(st.host.querySelectorAll<HTMLButtonElement>("button"))) {
      const on = b.dataset.value === sel.value;
      b.setAttribute("aria-checked", String(on));
      b.classList.toggle("choice-on", on);
    }
  } else {
    const text = st.host.querySelector(".choice-text");
    const cur = sel.selectedOptions[0];
    if (text) text.textContent = cur ? label(cur) : "—";
    st.host.querySelector(".choice-trigger")?.classList.toggle("choice-placeholder", !cur || isPlaceholder(cur));
  }
}

/** Jangan ubah DOM yang belum di-hydrate React (bagian halaman yang masih streaming) agar tidak terjadi hydration mismatch */
const hydrated = (el: Element) => Object.keys(el).some((k) => k.startsWith("__reactFiber$"));

function enhance(sel: HTMLSelectElement) {
  if (sel.multiple || sel.hasAttribute("data-plain") || sel.closest("[data-plain-select]")) return;
  if (!states.has(sel) && !hydrated(sel)) return;
  const sig = signature(sel);
  let st = states.get(sel);
  if (st && st.sig === sig && st.host.isConnected) return sync(sel, st);
  const mode: ChoiceMode = sel.hasAttribute("data-dropdown") ? "search" : choiceMode(choices(sel).length);
  if (!st || !st.host.isConnected) {
    const host = document.createElement("div");
    sel.after(host);
    sel.classList.add("choice-native");
    sel.tabIndex = -1;
    sel.setAttribute("aria-hidden", "true");
    // <select> asli tidak boleh membuka pilihan bawaan HP (iPhone kadang memindahkan fokus ke sini
    // setelah pilihan diklik sehingga dropdown muncul dua kali). Alihkan fokusnya ke tombol pengganti.
    sel.addEventListener("focus", () => {
      // Biarkan pesan "wajib diisi" bawaan browser tampil bila pilihan masih kosong
      if (!sel.validity.valid) return;
      sel.blur();
      const t = states.get(sel)?.host.querySelector<HTMLElement>(".choice-trigger, button");
      t?.focus({ preventScroll: true });
    });
    sel.addEventListener("mousedown", (e) => e.preventDefault());
    sel.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    st = { host, mode, sig };
    states.set(sel, st);
  }
  st.close?.();
  st.close = undefined;
  st.mode = mode;
  st.sig = sig;
  if (mode === "buttons") renderButtons(sel, st.host);
  else renderSearch(sel, st.host, st);
  sync(sel, st);
}

function scan() {
  for (const [sel, st] of states) {
    if (!sel.isConnected) {
      st.close?.();
      st.host.remove();
      states.delete(sel);
    }
  }
  document.querySelectorAll<HTMLSelectElement>("select").forEach(enhance);
}

const inputSetter = typeof window !== "undefined" ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set : undefined;
const areaSetter = typeof window !== "undefined" ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set : undefined;

/** Kapitalkan huruf pertama tiap kata pada isian teks (saat keluar dari kolom & sebelum form dikirim) */
function capitalizeField(el: EventTarget | null) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  if (!shouldCapitalize(el)) return;
  const next = capitalizeWords(el.value);
  if (next === el.value) return;
  (el instanceof HTMLInputElement ? inputSetter : areaSetter)?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function ChoiceEnhancer() {
  useEffect(() => {
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        scan();
      });
    };
    scan();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    const onChange = (e: Event) => {
      const t = e.target;
      if (t instanceof HTMLSelectElement) {
        const st = states.get(t);
        if (st) sync(t, st);
      }
    };
    document.addEventListener("change", onChange);
    const onReset = () => setTimeout(scan, 0);
    const onBlur = (e: FocusEvent) => capitalizeField(e.target);
    const onSubmit = (e: Event) => {
      if (e.target instanceof HTMLFormElement) Array.from(e.target.elements).forEach(capitalizeField);
    };
    document.addEventListener("focusout", onBlur, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("reset", onReset, true);
    // Nilai yang diubah React lewat state (tanpa event) tetap tersinkron
    const timer = setInterval(scan, 600);
    return () => {
      mo.disconnect();
      clearInterval(timer);
      document.removeEventListener("change", onChange);
      document.removeEventListener("reset", onReset, true);
      document.removeEventListener("focusout", onBlur, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }, []);
  return null;
}
