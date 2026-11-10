import { ElectronUI, removeRoot } from "./ui/electron";
import { localCases } from "./ui/local";
import { mkdtemp } from "node:fs/promises";
import { test } from "bun:test";

// Backwards-compatible opt-in entry point; the maintained command is test:ui:local.
test.skipIf(process.platform !== "darwin" || process.env.PALLET_TEST_UI !== "1")(
  "real Electron local UI regressions (including rename focus and narrow filenames)",
  async () => {
    const root = await mkdtemp("/tmp/pallet-ui-offline-");
    const ui = new ElectronUI(root);
    try {
      await ui.start();
      for (const [, run] of localCases(root)) await run(ui);
    } catch (error) {
      await ui.diagnostics("offline-ui");
      throw error;
    } finally {
      await ui.close();
      await removeRoot(root);
    }
  },
  60000,
);
