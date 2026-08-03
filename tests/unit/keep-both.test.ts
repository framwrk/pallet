import { describe, expect, test } from "bun:test";
import { keepBothName } from "../../src/shared/keep-both";

const set = (...names: string[]): Set<string> => new Set(names);

describe("keepBothName", () => {
  test("no clash returns the name itself", () => {
    expect(keepBothName(set("other.txt"), "file.txt")).toBe("file.txt");
  });

  test("first clash appends (2) before the extension", () => {
    expect(keepBothName(set("file.txt"), "file.txt")).toBe("file (2).txt");
  });

  test("counts past existing copies", () => {
    expect(keepBothName(set("file.txt", "file (2).txt", "file (3).txt"), "file.txt")).toBe("file (4).txt");
  });

  test('a "(n)" source keeps counting from its base', () => {
    expect(keepBothName(set("file (2).txt", "file (3).txt"), "file (2).txt")).toBe("file (4).txt");
  });

  test("extensionless and dotfiles", () => {
    expect(keepBothName(set("Makefile"), "Makefile")).toBe("Makefile (2)");
    expect(keepBothName(set(".env"), ".env")).toBe(".env (2)");
  });

  test("directories with dots in the name treat the tail as extension", () => {
    expect(keepBothName(set("archive.tar.gz"), "archive.tar.gz")).toBe("archive.tar (2).gz");
  });
});
