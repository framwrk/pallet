import { ElectronUI, checkInterrupted, interrupt, removeRoot } from "./electron";
import { localCases, settingsCases } from "./local";
import { Servers } from "./servers";
import { integrationCases } from "./integration";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

const mode = process.argv[2];
if (!["local", "integration", "native"].includes(mode))
  throw new Error("Usage: bun run test-server/ui/run.ts local|integration|native");
const root = await mkdtemp("/tmp/pallet-ui-");
console.log(`UI fixtures: ${root} (${mode})`);
const servers = mode === "integration" ? new Servers(root) : undefined;
const ui = new ElectronUI(root, { ...process.env, SSH_AUTH_SOCK: servers?.socket ?? join(root, "no-user-agent") });
let cleanupPromise: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return (cleanupPromise ??= (async () => {
    const results = await Promise.allSettled([ui.close(), servers?.close()]);
    const errors = results.filter((r) => r.status === "rejected");
    if (errors.length) throw new AggregateError(errors, `Cleanup failed; owned resources remain under ${root}`);
    await removeRoot(root);
  })());
}
let interruptedSignal: string | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    interruptedSignal = signal;
    interrupt(signal);
    console.error(`Interrupted by ${signal}; stopping at the next bounded operation and removing owned resources`);
  });
let current = "prerequisites";
let passed = 0;
try {
  await servers?.start();
  if (servers) console.log(`Owned containers: ${[...servers.containers.values()].join(", ")}`);
  await ui.start();
  const cases =
    mode === "local" ? localCases(root) : mode === "native" ? settingsCases(root) : integrationCases(root, servers!);
  for (const [name, run] of cases) {
    checkInterrupted();
    current = name;
    const start = Date.now();
    await run(ui);
    console.log(`PASS ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    passed++;
  }
  console.log(`${mode}: ${passed}/${cases.length} passed, 0 skipped`);
  if (mode === "local")
    console.log(
      "Not selected: integration and native suites (run test:ui:integration and test:ui:native). See docs/ui-regression.md for manual coverage.",
    );
} catch (error) {
  if (servers) console.error(servers.logs());
  console.error(`Last interaction: ${ui.lastAction}`);
  console.error(`FAIL ${current} (${passed} earlier cases passed)`);
  // Error text may originate from a form assertion; scrub the fixture password.
  console.error(
    String(error)
      .split(servers?.password ?? "\u0000")
      .join("[REDACTED]"),
  );
  await ui.diagnostics(current, servers ? [servers.password] : []).catch((e) => console.error(`Diagnostics unavailable: ${e}`));
  process.exitCode = interruptedSignal === "SIGINT" ? 130 : interruptedSignal === "SIGTERM" ? 143 : 1;
} finally {
  await cleanup().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
