import "@xterm/xterm/css/xterm.css";
import { type ITheme, Terminal } from "@xterm/xterm";
import { openTerminal, registerTerminalSink, unregisterTerminalSink } from "@/store/terminal.store";
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

/**
 * Terminal ids whose shell main already has. React StrictMode re-runs mount
 * effects in development; without this, the extra cleanup would kill the
 * shell its replacement is about to reuse.
 */
const liveShells = new Set<string>();

function tokenColor(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !raw) return fallback;
  context.fillStyle = fallback;
  context.fillStyle = raw;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function themeFromTokens(): ITheme {
  const background = tokenColor("--background", "#101116");
  const foreground = tokenColor("--foreground", "#f5f5f7");
  const primary = tokenColor("--primary", "#0a84ff");
  return {
    background,
    foreground,
    cursor: primary,
    cursorAccent: background,
    selectionBackground: withAlpha(primary, 0.3),
  };
}

function terminalFontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-file").trim() || "monospace";
}

export function TerminalView({
  paneId,
  terminalId,
  sessionId,
  visible,
}: {
  paneId: "left" | "right";
  terminalId: string;
  sessionId: string;
  visible: boolean;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const visibleRef = useRef(visible);
  const mountedRef = useRef(false);
  const [opening, setOpening] = useState(!liveShells.has(terminalId));

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: terminalFontFamily(),
      fontSize: 12,
      cursorBlink: false,
      scrollback: 5000,
      theme: themeFromTokens(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void window.pallet.app.openExternal(uri);
      }),
    );
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    // Menu roles own ⌘C/⌘V/⌘A, so xterm must not consume meta combos. ⌘K
    // clears the screen, the macOS Terminal convention.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && event.metaKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        term.clear();
        return false;
      }
      return !event.metaKey;
    });

    const input = term.onData((data) => window.pallet.terminal.write(terminalId, data));
    const sink = (data: Uint8Array): void => term.write(data);
    registerTerminalSink(terminalId, sink);

    const themeObserver = new MutationObserver(() => {
      term.options.theme = themeFromTokens();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    let sent = { cols: 0, rows: 0 };
    const measure = (): void => {
      // A hidden container measures 0×0, which would shrink the PTY.
      if (!visibleRef.current) return;
      fit.fit();
      if (term.cols === sent.cols && term.rows === sent.rows) return;
      sent = { cols: term.cols, rows: term.rows };
      window.pallet.terminal.resize(terminalId, term.cols, term.rows);
    };
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(container);
    fit.fit();
    sent = { cols: term.cols, rows: term.rows };

    const reuse = liveShells.has(terminalId);
    liveShells.add(terminalId);
    mountedRef.current = true;
    if (!reuse) {
      void openTerminal(paneId, terminalId, term.cols, term.rows).finally(() => {
        if (mountedRef.current) setOpening(false);
      });
    }

    return () => {
      mountedRef.current = false;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      input.dispose();
      unregisterTerminalSink(terminalId);
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
      // Deferred so a StrictMode remount reuses the shell instead of racing it.
      liveShells.delete(terminalId);
      window.setTimeout(() => {
        if (liveShells.has(terminalId)) return;
        void window.pallet.terminal.close(terminalId).catch(() => {});
      }, 0);
    };
  }, [paneId, terminalId]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      data-terminal-id={terminalId}
      data-session-id={sessionId}
    >
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden px-2 pt-1"
      />
      {opening && (
        <div className="bg-background/60 text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-xs">
          Opening terminal…
        </div>
      )}
    </div>
  );
}
