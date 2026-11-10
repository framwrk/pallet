import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { checkInterrupted, stop, until } from "./electron";
import { createConnection } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const protocols = ["sftp", "ftp", "ftps"] as const;
export type Protocol = (typeof protocols)[number];
export class Servers {
  readonly password = `ui-${randomUUID()}`;
  readonly containers = new Map<Protocol, string>();
  readonly ports = new Map<Protocol, number>();
  agent?: ChildProcess;
  constructor(readonly root: string) {}
  path(p: Protocol): string {
    return join(this.root, p);
  }
  remote(p: Protocol): string {
    return p === "sftp" ? "/home/pallet" : "/";
  }
  get key(): string {
    return join(this.root, "client-key");
  }
  get socket(): string {
    return join(this.root, "agent.sock");
  }
  docker(args: string[], input?: string): string {
    // Never print Docker argv/errors: env includes a synthetic password.
    try {
      return execFileSync("docker", args, { input, encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      throw new Error(`Docker ${args[0]} failed (check daemon, cached image and available loopback ports)`);
    }
  }
  exec(p: Protocol, args: string[]): string {
    return this.docker(["exec", this.containers.get(p)!, ...args]);
  }
  async start(): Promise<void> {
    const image = process.env.PALLET_UI_SERVER_IMAGE;
    if (!image)
      throw new Error(
        "Set PALLET_UI_SERVER_IMAGE to an existing image built from test-server/Dockerfile; suite never builds or pulls images",
      );
    this.docker(["info", "--format", "{{.ServerVersion}}"]);
    this.docker(["image", "inspect", image]);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", this.key], { stdio: "pipe" });
    const basePort = 40000 + Math.floor(Math.random() * 120) * 192;
    for (const p of protocols) {
      checkInterrupted();
      await mkdir(this.path(p));
      await chmod(this.path(p), 0o777);
      await writeFile(join(this.path(p), "ready.txt"), "ready\n");
      await mkdir(join(this.path(p), "sized", "empty"), { recursive: true });
      await writeFile(join(this.path(p), "sized", "a"), "123456");
      await writeFile(join(this.path(p), "sized", "empty", "b"), "12345678");
      const name = `pallet-ui-${randomUUID()}`;
      this.containers.set(p, name); // Register before docker run, including partial startup failures.
      const base = basePort + protocols.indexOf(p) * 64;
      const common = 'printf "pallet:%s\\n" "$PALLET_TEST_PASSWORD" | chpasswd\nchown -R pallet:pallet /home/pallet\n';
      let script: string;
      const passive = p === "sftp" ? [] : ["-p", `127.0.0.1:${base}-${base + 31}:${base}-${base + 31}`];
      if (p === "sftp") {
        const hostKey = join(this.root, "host-key");
        execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey], { stdio: "pipe" });
        await writeFile(join(this.path(p), "authorized_keys"), await readFile(`${this.key}.pub`));
        script =
          common +
          'exec /usr/sbin/sshd -D -e -f /dev/null -h /fixture/host-key -o ListenAddress=0.0.0.0 -o PasswordAuthentication=yes -o PubkeyAuthentication=yes -o AuthorizedKeysFile=/home/pallet/authorized_keys -o StrictModes=no -o "Subsystem=sftp internal-sftp"';
      } else {
        script =
          common +
          (p === "ftps"
            ? "test -f /fixture/test.pem || { openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -keyout /fixture/test.key -out /fixture/test.crt 2>/dev/null; cat /fixture/test.crt /fixture/test.key > /fixture/test.pem; }\n"
            : "") +
          `exec /usr/sbin/pure-ftpd -A -E -H -l unix -c 64 -C 64 -p ${base}:${base + 31} -P 127.0.0.1 -S 0.0.0.0,21 -Y ${p === "ftps" ? "2 -2 /fixture/test.pem" : "0"}`;
      }
      this.docker([
        "run",
        "--pull=never",
        "-d",
        "--name",
        name,
        "--label",
        "pallet.ui-test=true",
        "--cap-add=NET_ADMIN",
        "-p",
        `127.0.0.1:${base + 32}:${p === "sftp" ? 22 : 21}`,
        ...passive,
        "-v",
        `${this.root}:/fixture`,
        "-v",
        `${this.path(p)}:/home/pallet`,
        "-e",
        `PALLET_TEST_PASSWORD=${this.password}`,
        "--entrypoint",
        "/bin/sh",
        image,
        "-ec",
        script,
      ]);
      const address = this.docker(["port", name, p === "sftp" ? "22/tcp" : "21/tcp"]).trim();
      this.ports.set(p, Number(address.split(":").at(-1)));
      await this.ready(p);
    }
    this.agent = spawn("ssh-agent", ["-D", "-a", this.socket], { stdio: "ignore" });
    let error: Error | undefined;
    this.agent.on("error", (e) => {
      error = e;
    });
    await until(async () => {
      if (error) throw error;
      return access(this.socket).then(
        () => true,
        () => false,
      );
    }, "isolated ssh-agent socket");
    execFileSync("ssh-add", [this.key], { env: { ...process.env, SSH_AUTH_SOCK: this.socket }, stdio: "pipe", timeout: 10000 });
  }
  async ready(p: Protocol): Promise<void> {
    await until(
      () =>
        new Promise<boolean>((resolve) => {
          const socket = createConnection({ host: "127.0.0.1", port: this.ports.get(p)! });
          const done = (ok: boolean): void => {
            socket.destroy();
            resolve(ok);
          };
          socket.setTimeout(500);
          socket.once("connect", () => done(true));
          socket.once("error", () => done(false));
          socket.once("timeout", () => done(false));
        }),
      `${p} fixture listening`,
      15000,
    );
  }
  async rotateHostKey(): Promise<void> {
    const path = join(this.root, "rotated-key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path], { stdio: "pipe" });
    await writeFile(join(this.root, "host-key"), await readFile(path));
    await writeFile(join(this.root, "host-key.pub"), await readFile(`${path}.pub`));
    this.docker(["restart", this.containers.get("sftp")!]);
    await this.ready("sftp");
  }
  logs(): string {
    return [...this.containers.values()]
      .map((name) => {
        const r = spawnSync("docker", ["logs", "--tail", "20", name], { encoding: "utf8", timeout: 5000 });
        return `${name}\n${r.stdout}\n${r.stderr}`;
      })
      .join("\n")
      .split(this.password)
      .join("[REDACTED]");
  }
  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const name of this.containers.values()) {
      try {
        this.docker(["rm", "-f", name]);
      } catch (e) {
        errors.push(e);
      }
    }
    this.containers.clear();
    await stop(this.agent);
    if (errors.length) throw new AggregateError(errors, "Could not remove owned UI containers");
  }
}
