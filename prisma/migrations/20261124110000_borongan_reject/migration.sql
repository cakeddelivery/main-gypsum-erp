-- Patung reject per setoran borongan (aditif; data lama = 0)
ALTER TABLE "BoronganResult" ADD COLUMN "reject" INTEGER NOT NULL DEFAULT 0;
