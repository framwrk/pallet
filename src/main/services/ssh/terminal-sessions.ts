import type { ClientChannel, Client as SshClient } from "ssh2";
import type { TerminalDataEvent, TerminalExitEvent } from "@shared/terminal/terminal.types";
import type { SessionManager } from "../sftp/session-manager";

export interface TerminalSessionsHooks {
  onData(event: TerminalDataEvent): void;
  onExit(event: TerminalExitEvent): void;
}

interface Terminal {
  terminalId: string;
  sessionId: string;
  client: SshClient | null;
  channel: ClientChannel | null;
  cancelled: boolean;
  finished: boolean;
  exitCode: number | undefined;
}

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function codedError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

export class TerminalSessions {
  private terminals = new Map<string, Terminal>();
  private bySession = new Map<string, string>();

  constructor(
    private sessionManager: SessionManager,
    private hooks: TerminalSessionsHooks,
  ) {}

  async open(terminalId: string, sessionId: string, cols: number, rows: number): Promise<void> {
    if (this.terminals.has(terminalId) || this.bySession.has(sessionId)) {
      throw codedError("EEXIST", "A terminal is already open for this connection");
    }
    const terminal: Terminal = {
      terminalId,
      sessionId,
      client: null,
      channel: null,
      cancelled: false,
      finished: false,
      exitCode: undefined,
    };
    this.terminals.set(terminalId, terminal);
    this.bySession.set(sessionId, terminalId);

    try {
      const client = await this.sessionManager.openTerminalClient(sessionId);
      if (terminal.cancelled) {
        client.end();
        return;
      }
      terminal.client = client;
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        client.shell({ term: "xterm-256color", cols: dimension(cols), rows: dimension(rows) }, (err, shell) =>
          err ? reject(err) : resolve(shell),
        );
      });
      if (terminal.cancelled) {
        channel.close();
        client.end();
        return;
      }
      terminal.channel = channel;

      const onOutput = (chunk: Buffer): void => {
        if (terminal.finished) return;
        this.hooks.onData({ terminalId, data: Uint8Array.from(chunk) });
      };
      channel.on("data", onOutput);
      channel.stderr.on("data", onOutput);
      channel.on("exit", (code: number | null) => {
        if (typeof code === "number") terminal.exitCode = code;
      });
      channel.once("close", () => this.exit(terminal));
      channel.on("error", (err: Error) => this.fail(terminal, err));
      // A dropped connection closes the client without a channel exit code.
      client.once("close", () => this.fail(terminal, new Error("Connection lost")));
      client.once("error", (err: Error) => this.fail(terminal, err));
    } catch (err) {
      this.release(terminal);
      throw err;
    }
  }

  write(terminalId: string, data: string): void {
    const channel = this.terminals.get(terminalId)?.channel;
    if (!channel || !data) return;
    channel.stdin.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal?.channel) return;
    terminal.channel.setWindow(dimension(rows), dimension(cols), 0, 0);
  }

  /** User-initiated close: the renderer already knows, so emit no exit. */
  close(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    terminal.cancelled = true;
    this.release(terminal);
  }

  closeForSession(sessionId: string): void {
    const terminalId = this.bySession.get(sessionId);
    if (terminalId) this.close(terminalId);
  }

  closeAll(): void {
    for (const terminalId of [...this.terminals.keys()]) this.close(terminalId);
  }

  private exit(terminal: Terminal): void {
    this.release(terminal, {
      terminalId: terminal.terminalId,
      reason: "exit",
      ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
    });
  }

  private fail(terminal: Terminal, err: unknown): void {
    const message = err instanceof Error && err.message ? err.message : "Connection lost";
    this.release(terminal, { terminalId: terminal.terminalId, reason: "error", message });
  }

  private release(terminal: Terminal, event?: TerminalExitEvent): void {
    if (terminal.finished) return;
    terminal.finished = true;
    this.terminals.delete(terminal.terminalId);
    if (this.bySession.get(terminal.sessionId) === terminal.terminalId) this.bySession.delete(terminal.sessionId);
    try {
      terminal.channel?.close();
    } catch {
      // Already closed.
    }
    try {
      terminal.client?.end();
    } catch {
      // Already closed.
    }
    if (event) this.hooks.onExit(event);
  }
}
