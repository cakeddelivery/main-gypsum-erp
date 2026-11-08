#!/usr/bin/env bash
# Ubah URL database (postgresql://user:password@host:port/db) menjadi variabel
# PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE lalu export ke shell ini.
# Tujuannya: password TIDAK ikut di argumen pg_dump/psql/pg_restore, karena
# argumen perintah bisa dibaca semua user lewat `ps`. Variabel environment
# hanya bisa dibaca oleh user yang sama (dan root).
# Query string (?schema=public, dll.) diabaikan, sama seperti sebelumnya.
# Pakai: pg_env_from_url "$DATABASE_URL"   (sebaiknya di dalam subshell ( ... ))
pg_env_from_url() {
  local out
  # URL dikirim lewat environment, bukan argumen, supaya tidak terlihat di ps
  out="$(PG_URL="$1" node -e '
    const u = new URL(process.env.PG_URL);
    const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
    const d = (s) => decodeURIComponent(s || "");
    const v = {
      PGHOST: u.hostname.replace(/^\[|\]$/g, "") || "localhost",
      PGPORT: u.port || "5432",
      PGUSER: d(u.username),
      PGPASSWORD: d(u.password),
      PGDATABASE: d(u.pathname.replace(/^\//, "")),
    };
    for (const [k, val] of Object.entries(v)) {
      if (val) console.log("export " + k + "=" + q(val));
      else console.log("unset " + k);
    }
  ')" || { echo "URL database tidak valid" >&2; return 1; }
  eval "$out"
}
