import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const compose = readFileSync(join(import.meta.dir, "..", "docker-compose.yml"), "utf8");

// Host port mappings are the quoted list items under each service's `ports:` key.
function publishedPorts(): string[] {
  const ports: string[] = [];
  let inPorts = false;
  for (const line of compose.split("\n")) {
    if (/^\s+ports:\s*$/.test(line)) {
      inPorts = true;
    } else if (inPorts) {
      const mapping = line.match(/^\s+- "([^"]+)"$/);
      if (mapping) ports.push(mapping[1]);
      else if (!/^\s*-/.test(line)) inPorts = false;
    }
  }
  return ports;
}

test("test servers publish every host port on loopback", () => {
  const ports = publishedPorts();
  expect(ports).toHaveLength(5);
  for (const mapping of ports) {
    expect(mapping.split(":")[0]).toBe("127.0.0.1");
  }
});

test("passive FTP and FTPS ranges are published on loopback", () => {
  const ports = publishedPorts();
  expect(ports).toContain("127.0.0.1:30000-30009:30000-30009");
  expect(ports).toContain("127.0.0.1:30100-30109:30100-30109");
});
