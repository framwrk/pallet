import { expect, test } from "bun:test";
import type { PluginOption } from "vite";
import electronViteConfig from "../electron.vite.config";
import shimConfig from "../vite.config";

function pluginNames(plugins: PluginOption[] | undefined): string[] {
  return (plugins ?? []).flat(Infinity as 1).flatMap((p) => (p && typeof p === "object" && "name" in p ? [p.name] : []));
}

const renderer = (electronViteConfig as { renderer: { plugins?: PluginOption[]; resolve: { alias: Record<string, string> } } })
  .renderer;
const shim = shimConfig as { plugins?: PluginOption[]; resolve: { alias: Record<string, string> } };

test("the root Vite shim loads the same plugins as the electron-vite renderer", () => {
  expect(pluginNames(shim.plugins)).toEqual(pluginNames(renderer.plugins));
});

test("the root Vite shim uses the same aliases as the electron-vite renderer", () => {
  expect(shim.resolve.alias).toEqual(renderer.resolve.alias);
});
