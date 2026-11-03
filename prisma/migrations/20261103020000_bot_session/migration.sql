CREATE TABLE "BotSession" (
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "flow" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BotSession_pkey" PRIMARY KEY ("chatId")
);
