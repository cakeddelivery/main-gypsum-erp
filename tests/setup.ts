// Test memakai database terpisah (TEST_DATABASE_URL), di-reset oleh tests/global-reset.sh
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://mg:mg@localhost:5432/mg_erp_test";
process.env.AUTH_SECRET ||= "test-secret-test-secret-test-secret-123";
process.env.STORAGE_DIR ||= "./storage/test";
process.env.TELEGRAM_BOT_TOKEN = "";
