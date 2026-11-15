-- Durasi maksimal video unboxing retur menjadi 10 menit (hanya bila masih nilai lama 5 menit)
UPDATE "Setting" SET "value" = '10' WHERE "key" = 'retur_video_maks_menit' AND "value" = '5';
