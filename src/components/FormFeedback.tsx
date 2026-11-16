"use client";
import { useEffect } from "react";

/**
 * Umpan balik isian untuk SEMUA form (dipasang sekali di Shell):
 * - Kolom yang belum benar (wajib diisi, angka di luar batas, dll.) diberi garis merah, bergetar pelan,
 *   dan pesan muncul halus di bawahnya — menggantikan gelembung bawaan browser yang mudah terlewat di HP.
 * - Layar otomatis menggulir ke kolom PERTAMA yang salah lalu fokus ke sana.
 * - Pesan hilang sendiri begitu kolom diperbaiki.
 * - Di HP, kolom yang disentuh digulir ke tengah agar tidak tertutup keyboard.
 */

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Putar ulang animasi getar pada elemen */
export function shake(el: Element) {
  el.classList.remove("anim-shake");
  void (el as HTMLElement).offsetWidth; // paksa reflow agar animasi bisa diulang
  el.classList.add("anim-shake");
}

/** Gulir elemen ke tengah area yang terlihat (popup atau halaman), opsional fokus */
export function revealField(el: HTMLElement, focus = true) {
  el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
  if (focus) el.focus({ preventScroll: true });
}

/** Elemen yang benar-benar terlihat untuk sebuah kolom: tombol pengganti dropdown (ChoiceEnhancer) atau kolom itu sendiri */
function visibleTarget(el: HTMLElement): HTMLElement {
  if (el.classList.contains("choice-native")) {
    const host = el.nextElementSibling as HTMLElement | null;
    if (host?.matches(".choice-seg, .choice-search")) return host;
  }
  return el;
}

function focusTarget(el: HTMLElement): HTMLElement {
  const t = visibleTarget(el);
  if (t === el) return el;
  return t.querySelector<HTMLElement>(".choice-trigger, button.choice-on, button") ?? t;
}

/** Tempat pesan: setelah kolom, atau setelah pembungkus dropdown/label kotak centang */
function messageAnchor(el: HTMLElement): HTMLElement {
  const t = visibleTarget(el);
  if (t !== el) return t;
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.closest("label") ?? el;
  return el;
}

function messageFor(el: HTMLElement & { validity: ValidityState; validationMessage: string }) {
  const v = el.validity;
  if (v.valueMissing) {
    if (el instanceof HTMLSelectElement) return "Pilih salah satu dulu";
    if (el instanceof HTMLInputElement && el.type === "file") return "Lampirkan file dulu";
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return "Wajib dicentang/dipilih";
    return "Wajib diisi";
  }
  return el.validationMessage || "Isian belum benar";
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function clear(el: Field) {
  el.removeAttribute("aria-invalid");
  visibleTarget(el).classList.remove("field-invalid", "anim-shake");
  const id = el.getAttribute("data-err-id");
  if (id) document.getElementById(id)?.remove();
  el.removeAttribute("data-err-id");
}

let seq = 0;

/**
 * Tampilkan kolom yang tersembunyi agar bisa difokus: buka <details> yang menutupinya dan kabari
 * stepper/popup bertahap (event "field-reveal") supaya membuka langkah yang berisi kolom itu.
 * Mengembalikan true bila tampilan berubah (perlu jeda sebelum menggulir).
 */
function unhide(el: HTMLElement): boolean {
  let changed = false;
  for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) {
    if (!d.open) {
      d.open = true;
      changed = true;
    }
  }
  const before = el.getClientRects().length;
  el.dispatchEvent(new CustomEvent("field-reveal", { bubbles: true }));
  return changed || before === 0;
}

/** Tandai satu kolom salah: garis merah + getar + pesan di bawahnya; opsional gulir & fokus ke sana */
export function markInvalid(el: Field, text: string, reveal = true) {
  const target = visibleTarget(el);
  el.setAttribute("aria-invalid", "true");
  target.classList.add("field-invalid");
  shake(target);
  let msg = el.getAttribute("data-err-id") ? document.getElementById(el.getAttribute("data-err-id")!) : null;
  if (!msg) {
    msg = document.createElement("span");
    msg.id = `fe-${++seq}`;
    msg.className = "field-error";
    msg.setAttribute("role", "alert");
    messageAnchor(el).after(msg);
    el.setAttribute("data-err-id", msg.id);
    el.setAttribute("aria-describedby", [el.getAttribute("aria-describedby"), msg.id].filter(Boolean).join(" "));
  }
  msg.textContent = text;
  if (!reveal) return;
  if (unhide(el)) window.setTimeout(() => revealField(focusTarget(el)), 80);
  else revealField(focusTarget(el));
}

/** Label yang terlihat untuk sebuah kolom (untuk mencocokkan pesan error server dengan kolomnya) */
function labelOf(el: Field): string {
  const t = el.labels?.[0]?.textContent || el.getAttribute("aria-label") || el.closest("label")?.textContent || el.getAttribute("placeholder") || "";
  return t.replace(/[*:()]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

const fieldList = (form: HTMLFormElement) =>
  Array.from(form.elements).filter((x): x is Field => (x instanceof HTMLInputElement || x instanceof HTMLSelectElement || x instanceof HTMLTextAreaElement) && !!x.name && !(x instanceof HTMLInputElement && x.type === "hidden"));

/**
 * Server menolak simpan: tandai kolom yang disebut server (name → pesan). Bila server tidak menyebut kolom,
 * cari kolom yang labelnya disebut dalam pesan error. Kolom pertama digulir & difokus.
 * Mengembalikan true bila ada kolom yang ditandai.
 */
export function showServerErrors(form: HTMLFormElement, error: string, fields?: Record<string, string>): boolean {
  const all = fieldList(form);
  const hits: [Field, string][] = [];
  if (fields) {
    for (const [name, text] of Object.entries(fields)) {
      const el = all.find((x) => x.name === name) ?? all.find((x) => x.name.startsWith(`${name}.`) || x.name.startsWith(`${name}:`));
      if (el) hits.push([el, text]);
    }
  }
  if (!hits.length) {
    const msg = error.toLowerCase();
    const el = all.find((x) => {
      const l = labelOf(x);
      return l.length >= 3 && l.length <= 40 && msg.includes(l);
    });
    if (el) hits.push([el, error]);
  }
  hits.sort(([a], [b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  hits.forEach(([el, text], i) => markInvalid(el, text, i === 0));
  return hits.length > 0;
}

export function FormFeedback() {
  useEffect(() => {
    // Satu kali kirim memicu banyak event "invalid"; hanya yang pertama digulir & difokus
    let firstDone = false;
    let reset: number | undefined;

    const onInvalid = (e: Event) => {
      const el = e.target as Field;
      if (!el?.form) return;
      e.preventDefault(); // ganti gelembung bawaan browser dengan pesan di bawah kolom
      markInvalid(el, messageFor(el), !firstDone);
      firstDone = true;
      window.clearTimeout(reset);
      reset = window.setTimeout(() => (firstDone = false), 0);
    };

    const onFix = (e: Event) => {
      const el = e.target as Field;
      if (!el?.hasAttribute?.("aria-invalid")) return;
      if (el.validity.valid) clear(el);
    };

    // Formulir dikosongkan (reset) → pesan lama ikut hilang
    const onReset = (e: Event) => {
      (e.target as HTMLFormElement).querySelectorAll<Field>("[aria-invalid]").forEach(clear);
    };

    // HP: kolom yang difokus digulir ke tengah setelah keyboard muncul, agar tidak tertutup keyboard
    let focusTimer: number | undefined;
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      if (!el.matches?.("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea")) return;
      if (!window.matchMedia("(pointer: coarse)").matches) return;
      window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(() => {
        if (document.activeElement !== el) return;
        const vv = window.visualViewport;
        const bottom = vv ? vv.height + vv.offsetTop : window.innerHeight;
        const r = el.getBoundingClientRect();
        if (r.bottom > bottom - 16 || r.top < 56) el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
      }, 350);
    };

    document.addEventListener("invalid", onInvalid, true);
    document.addEventListener("input", onFix, true);
    document.addEventListener("change", onFix, true);
    document.addEventListener("reset", onReset, true);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("invalid", onInvalid, true);
      document.removeEventListener("input", onFix, true);
      document.removeEventListener("change", onFix, true);
      document.removeEventListener("reset", onReset, true);
      document.removeEventListener("focusin", onFocus);
    };
  }, []);
  return null;
}
