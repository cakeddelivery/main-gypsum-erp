# Notifikasi push (PWA)

Web Push + VAPID dari pustaka `web-push`. Tanpa kunci VAPID, fitur ini diam:
- ajakan notifikasi tidak muncul;
- job pengingat tidak mengirim apa-apa.

| Bagian | File |
|---|---|
| Kirim ke user: `sendPush(userIds, { title, body, url, tag })` (fungsi umum untuk dipakai fitur lain) | `src/lib/push.ts` |
| Langganan per perangkat | tabel `PushSubscription` (migrasi `20261129100000_push_notifikasi`) |
| Tampilkan & klik notifikasi | `public/sw.js` (event `push`, `notificationclick`, VERSION v2) |
| Ajakan "Aktifkan notifikasi" + petunjuk bila diblokir / iPhone belum dipasang | `src/components/PushNotif.tsx` (`PushPrompt` di layout) |
| Pengaturan di **Profil › Notifikasi** (aktif/nonaktif per perangkat, Kirim tes) | `PushSettings` |
| Pengingat 12.00 & 15.00 WIB | `src/lib/pushReminders.ts`, dipanggil `runDueJobs` (`maingypsum-jadwal`) |
| Ketuk notifikasi → laporan hari ini + popup | `/laporan/buka?f=masuk` (+ Barang masuk) atau `?f=terima` (+ Penerimaan borongan) |

## Aturan pengingat

**12.00 dan 15.00 WIB.** Tiap slot terkirim sekali per hari, dengan jendela 3 jam bila server sempat mati.

**Penerima anggota divisi:** hanya yang hari itu **sudah absen masuk dan belum absen pulang**. Yang libur, izin, sakit, atau belum datang tidak dikirimi.

| Pengingat | Untuk | Isi |
|---|---|---|
| "Apakah ada barang masuk?" | semua divisi yang punya format laporan | jumlah barang masuk tercatat hari itu |
| "Apakah ada setoran borongan yang diterima?" | divisi penerima: Assembling, Giftbox, atau divisi pemilik tugas borongan | setoran koordinator vs penerimaan divisi hari itu, dengan "→ cek selisih" bila belum diterima |

**Supervisor & Owner** menerima ringkasan semua divisi.

Kirim berhasil maupun gagal dicatat di `NotificationLog` (channel `PUSH`). Langganan yang kedaluwarsa (404/410) atau yang gagal 5 kali dihapus otomatis.

## Memasang kunci VAPID di VPS (sekali, tanpa menampilkan kunci)

Untuk produksi:

```bash
cd ~/main-gypsum-erp && grep -q '^VAPID_PRIVATE_KEY=[A-Za-z0-9_-]' .env || node -e "const k=require('web-push').generateVAPIDKeys();console.log('VAPID_PUBLIC_KEY='+k.publicKey+'\nVAPID_PRIVATE_KEY='+k.privateKey+'\nVAPID_SUBJECT=mailto:admin@maingypsum.shop')" >> .env && pm2 restart maingypsum maingypsum-jadwal --update-env && echo "Kunci VAPID terpasang"
```

Untuk staging (folder & kunci terpisah):

```bash
cd ~/main-gypsum-erp-staging && grep -q '^VAPID_PRIVATE_KEY=[A-Za-z0-9_-]' .env || node -e "const k=require('web-push').generateVAPIDKeys();console.log('VAPID_PUBLIC_KEY='+k.publicKey+'\nVAPID_PRIVATE_KEY='+k.privateKey+'\nVAPID_SUBJECT=mailto:admin@maingypsum.shop')" >> .env && pm2 restart maingypsum-staging --update-env && echo "Kunci VAPID staging terpasang"
```

- Kunci dibuat sekali. Mengganti kunci membuat semua perangkat harus mengaktifkan notifikasi lagi; aplikasi otomatis mendaftar ulang bila izin sudah diberikan.
- Kunci publik dikirim ke HP (aman). Kunci privat hanya di `.env` server: jangan disalin ke chat atau repo.

## iPhone

Notifikasi web hanya jalan di iOS 16.4+ untuk ERP yang **dipasang ke Layar Utama** (Safari → Bagikan → Tambah ke Layar Utama). Aplikasi mendeteksi ini dan menampilkan petunjuknya.
