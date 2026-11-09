import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import path from "node:path";

/**
 * Semua file tes memakai satu database uji bersama, jadi urutannya harus tetap. Urutan bawaan vitest berubah
 * menurut cache waktu jalan & ukuran file sehingga hasil bisa berbeda antar-jalan; di sini selalu urut nama file.
 */
class NameSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src"), "server-only": path.resolve(__dirname, "tests/server-only-stub.ts") } },
  test: { environment: "node", fileParallelism: false, testTimeout: 30000, setupFiles: ["./tests/setup.ts"], sequence: { sequencer: NameSequencer } },
});
