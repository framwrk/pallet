import { KEYBINDING_COMMANDS, RESERVED_KEYS, defaultBindings } from "../src/shared/keybindings/keybinding.constants";
import { describe, expect, test } from "bun:test";
import {
  displayParts,
  eventToKey,
  findConflict,
  formatKey,
  parseKey,
  resolveBindings,
  serializeOverrides,
  toAccelerator,
  validateKey,
} from "../src/shared/keybindings/keybinding.utils";

describe("parseKey", () => {
  test("normalizes aliases, modifier order, and case", () => {
    expect(parseKey("Meta+Control+Shift+Alt+a")).toBe("cmd+ctrl+alt+shift+a");
    expect(parseKey("Command+Z")).toBe("cmd+z");
    expect(parseKey("option+cmd+ArrowUp")).toBe("cmd+alt+up");
    expect(parseKey(" Return ")).toBe("enter");
    expect(parseKey("shift+esc")).toBe("shift+escape");
    expect(parseKey("A")).toBe("a");
  });

  test("rejects unparseable input", () => {
    expect(parseKey("numpad1")).toBeNull();
    expect(parseKey("cmd")).toBeNull();
    expect(parseKey("cmd+cmd+a")).toBeNull();
    expect(parseKey("hyper+a")).toBeNull();
    expect(parseKey("cmd+")).toBeNull();
  });
});

describe("validateKey", () => {
  test("bare letters, digits, and symbols need a command modifier", () => {
    expect(validateKey("j", { allowEscape: true })?.code).toBe("needsModifier");
    expect(validateKey("5", { allowEscape: true })?.code).toBe("needsModifier");
    expect(validateKey(".", { allowEscape: true })?.code).toBe("needsModifier");
    expect(validateKey("shift+j", { allowEscape: true })?.code).toBe("needsModifier");
  });

  test("special keys and modified keys are valid", () => {
    for (const key of ["f5", "shift+enter", "ctrl+j", "cmd+shift+.", "shift+space", "left"]) {
      expect(validateKey(key, { allowEscape: true })).toBeNull();
    }
  });

  test("reserved, locked, unsupported, and UI-Escape keys are rejected", () => {
    for (const key of RESERVED_KEYS) {
      expect(validateKey(key, { allowEscape: true })?.code).toBe("reserved");
    }
    expect(validateKey("up", { allowEscape: true })?.code).toBe("locked");
    expect(validateKey("shift+up", { allowEscape: true })?.code).toBe("locked");
    expect(validateKey("numpad1", { allowEscape: true })?.code).toBe("unsupported");
    expect(validateKey("escape", { allowEscape: false })?.code).toBe("escapeReserved");
    expect(validateKey("escape", { allowEscape: true })).toBeNull();
  });

  test("every registry default is valid", () => {
    for (const command of KEYBINDING_COMMANDS) {
      expect(validateKey(command.defaultKey, { allowEscape: true })).toBeNull();
    }
  });
});

describe("resolveBindings", () => {
  test("reports unknown commands and keeps defaults", () => {
    const result = resolveBindings({ "foo.bar": "cmd+x" });
    expect(result.issues.map((issue) => issue.code)).toEqual(["unknownCommand"]);
    expect(result.effective["navigation.refresh"]).toBe("cmd+r");
  });

  test("reports a non-string value and keeps defaults", () => {
    const result = resolveBindings({ "files.newFolder": ["cmd+n"] });
    expect(result.issues.map((issue) => issue.code)).toEqual(["notKey"]);
    expect(result.effective["files.newFolder"]).toBe("cmd+shift+n");
  });

  test("reports an invalid key and keeps defaults", () => {
    const result = resolveBindings({ "files.newFolder": "j" });
    expect(result.issues.map((issue) => issue.code)).toEqual(["invalidKey"]);
    expect(result.effective["files.newFolder"]).toBe("cmd+shift+n");
  });

  test("the earlier command keeps a cross-command conflict", () => {
    const result = resolveBindings({
      "navigation.refresh": "cmd+d",
      "transfers.copyToOther": "cmd+d",
    });
    expect(result.effective["navigation.refresh"]).toBe("cmd+d");
    expect(result.effective["transfers.copyToOther"]).toBeNull();
    expect(result.issues.find((issue) => issue.code === "conflict")?.message).toBe("cmd+d is already used by Refresh");
  });

  test("a JSON swap applies both overrides before claims are checked", () => {
    const result = resolveBindings({
      "navigation.refresh": "cmd+shift+g",
      "navigation.goToFolder": "cmd+r",
    });
    expect(result.effective["navigation.refresh"]).toBe("cmd+shift+g");
    expect(result.effective["navigation.goToFolder"]).toBe("cmd+r");
    expect(result.issues).toEqual([]);
  });

  test("null means unbound", () => {
    const result = resolveBindings({ "panels.connect": null });
    expect(result.effective["panels.connect"]).toBeNull();
    expect(result.issues).toEqual([]);
  });

  test("rejects a non-object file shape", () => {
    const result = resolveBindings([1, 2]);
    expect(result.issues[0]?.code).toBe("shape");
    expect(result.effective).toEqual(defaultBindings());
  });

  test("findConflict ignores the command itself", () => {
    const { effective } = resolveBindings({});
    expect(findConflict(effective, "transfers.copyToOther", "f5")).toBeNull();
    expect(findConflict(effective, "navigation.refresh", "f5")).toBe("transfers.copyToOther");
  });
});

describe("eventToKey", () => {
  test("matches physical keys, so Option and Shift do not change the result", () => {
    expect(eventToKey({ code: "KeyA", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false })).toBe("alt+a");
    expect(eventToKey({ code: "Period", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe("cmd+shift+.");
  });

  test("returns null for modifier-only and unsupported keys", () => {
    expect(eventToKey({ code: "MetaLeft", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(eventToKey({ code: "Numpad1", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
  });
});

describe("toAccelerator", () => {
  test("maps canonical keys to Electron accelerators", () => {
    expect(toAccelerator("cmd+shift+.")).toBe("Cmd+Shift+.");
    expect(toAccelerator("enter")).toBe("Return");
    expect(toAccelerator("cmd+up")).toBe("Cmd+Up");
    expect(toAccelerator("ctrl+`")).toBe("Ctrl+`");
    expect(toAccelerator("alt+f5")).toBe("Alt+F5");
    expect(toAccelerator("space")).toBe("Space");
    expect(toAccelerator("escape")).toBe("Escape");
    expect(toAccelerator("cmd+shift+g")).toBe("Cmd+Shift+G");
  });
});

describe("display helpers", () => {
  test("puts modifiers first and uses key symbols", () => {
    expect(displayParts("cmd+shift+g")).toEqual(["⌘", "⇧", "G"]);
    expect(displayParts("ctrl+backspace")).toEqual(["⌃", "⌫"]);
    expect(displayParts("shift+up")).toEqual(["⇧", "↑"]);
    expect(formatKey("cmd+up")).toBe("⌘↑");
  });
});

describe("serializeOverrides", () => {
  test("writes an empty object with a trailing newline", () => {
    expect(serializeOverrides({})).toBe("{}\n");
  });

  test("drops an entry equal to its default", () => {
    expect(serializeOverrides({ "navigation.refresh": "cmd+r" })).toBe("{}\n");
    expect(serializeOverrides({ "transfers.copyToOther": "f5" })).toBe("{}\n");
  });

  test("keeps registry order and unbound entries", () => {
    const text = serializeOverrides({
      "panels.settings": "cmd+alt+,",
      "files.newFolder": "cmd+alt+n",
      "panels.connect": null,
    });
    const parsed = JSON.parse(text) as Record<string, string | null>;
    expect(Object.keys(parsed)).toEqual(["files.newFolder", "panels.connect", "panels.settings"]);
    expect(parsed["panels.connect"]).toBeNull();
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('  "files.newFolder"');
  });
});
