import { useState } from "react";
import { ChevronDown, ChevronRight, KeyRound, LockKeyhole, Star } from "lucide-react";
import type { ColorLabel, ConnectProfile, Favorite, FavoriteInput } from "@shared/types";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pushToast, setConnectOpen, useAppState } from "@/store/panes";
import { connectPane } from "@/store/sftp";
import { saveFavorite } from "@/store/favorites";

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="grid grid-cols-[7rem_1fr] items-center gap-3">
      <span className="text-muted-foreground text-right text-xs">{label}</span>
      {children}
    </label>
  );
}

const inputCls = "h-7 text-[13px]";

const COLORS: { value: ColorLabel; cls: string }[] = [
  { value: "none", cls: "bg-transparent border border-border" },
  { value: "red", cls: "bg-red-500" },
  { value: "orange", cls: "bg-orange-500" },
  { value: "yellow", cls: "bg-yellow-400" },
  { value: "green", cls: "bg-green-500" },
  { value: "blue", cls: "bg-blue-500" },
  { value: "purple", cls: "bg-purple-500" },
  { value: "gray", cls: "bg-gray-400" },
];

function ConnectForm({
  paneId,
  editing,
  prefill,
}: {
  paneId: "left" | "right";
  editing: Favorite | null;
  prefill: Favorite | null;
}): React.JSX.Element {
  const seed = editing ?? prefill;
  const [name, setName] = useState(seed?.name ?? "");
  const [server, setServer] = useState(seed?.host ?? "");
  const [port, setPort] = useState(String(seed?.port ?? 22));
  const [username, setUsername] = useState(seed?.username ?? "");
  const [authMethod, setAuthMethod] = useState<"password" | "key">(seed?.authMethod ?? "password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState(seed?.privateKeyPath ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [remotePathField, setRemotePathField] = useState(seed?.remotePath ?? "");
  const [localPathField, setLocalPathField] = useState(seed?.localPath ?? "");
  const [note, setNote] = useState(seed?.note ?? "");
  const [colorLabel, setColorLabel] = useState<ColorLabel>(seed?.colorLabel ?? "none");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [keepalive, setKeepalive] = useState("15");
  const [compression, setCompression] = useState(false);
  const [concurrency, setConcurrency] = useState("4");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const secretPlaceholder =
    seed?.secretStored && !editing ? "Stored password" : editing?.secretStored ? "Leave blank to keep saved" : "";

  function validate(): string | null {
    const portNum = Number.parseInt(port, 10);
    if (!server.trim() || !username.trim()) return "Server and username are required";
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return "Port must be 1–65535";
    if (authMethod === "key" && !keyPath.trim()) return "Choose a private key file";
    return null;
  }

  function favoriteInput(): FavoriteInput {
    return {
      ...(editing ? { id: editing.id } : {}),
      name: name.trim() || `${username.trim()}@${server.trim()}`,
      host: server.trim(),
      port: Number.parseInt(port, 10),
      username: username.trim(),
      authMethod,
      ...(authMethod === "key" && keyPath.trim() ? { privateKeyPath: keyPath.trim() } : {}),
      ...(remotePathField.trim() ? { remotePath: remotePathField.trim() } : {}),
      ...(localPathField.trim() ? { localPath: localPathField.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      colorLabel,
    };
  }

  /** The secret to persist alongside a favorite: password or key passphrase. */
  function enteredSecret(): string | undefined {
    const secret = authMethod === "password" ? password : passphrase;
    return secret.length > 0 ? secret : undefined;
  }

  async function doConnect(): Promise<void> {
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    const profile: ConnectProfile = {
      host: server.trim(),
      port: Number.parseInt(port, 10),
      username: username.trim(),
      auth:
        authMethod === "password"
          ? { method: "password", password }
          : { method: "key", keyPath: keyPath.trim(), ...(passphrase ? { passphrase } : {}) },
      ...(remotePathField.trim() ? { remotePath: remotePathField.trim() } : {}),
      keepaliveIntervalMs: Math.max(0, Number.parseInt(keepalive, 10) || 15) * 1000,
      compression,
      concurrency: Number.parseInt(concurrency, 10) || 4,
    };
    setBusy(true);
    setError(null);
    try {
      await connectPane(paneId, profile, localPathField.trim() || undefined);
    } catch (err) {
      setBusy(false);
      setError((err as Error).message);
    }
  }

  async function doSaveFavorite(close: boolean): Promise<void> {
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    const saved = await saveFavorite(favoriteInput(), enteredSecret());
    if (saved) {
      pushToast(close ? "Favorite saved" : `Added “${saved.name}” to Favorites`, "info");
      if (close) setConnectOpen(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (editing) void doSaveFavorite(true);
        else void doConnect();
      }}
    >
      {editing && (
        <Row label="Name">
          <Input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${username || "user"}@${server || "host"}`}
          />
        </Row>
      )}
      <Row label="Protocol">
        <div className="text-[13px] font-medium">SFTP</div>
      </Row>
      <Row label="Server">
        <Input
          className={inputCls}
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="example.com"
          spellCheck={false}
          autoFocus={!seed}
        />
      </Row>
      <Row label="Port">
        <Input
          className={cn(inputCls, "w-24")}
          value={port}
          onChange={(e) => setPort(e.target.value)}
          spellCheck={false}
        />
      </Row>
      <Row label="Username">
        <Input
          className={inputCls}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
        />
      </Row>
      <Row label="Authenticate">
        <div className="flex gap-1">
          <Button
            type="button"
            size="xs"
            variant={authMethod === "password" ? "secondary" : "ghost"}
            onClick={() => setAuthMethod("password")}
          >
            <LockKeyhole data-icon="inline-start" /> Password
          </Button>
          <Button
            type="button"
            size="xs"
            variant={authMethod === "key" ? "secondary" : "ghost"}
            onClick={() => setAuthMethod("key")}
          >
            <KeyRound data-icon="inline-start" /> Private Key
          </Button>
        </div>
      </Row>
      {authMethod === "password" ? (
        <Row label="Password">
          <Input
            className={inputCls}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={secretPlaceholder}
            autoFocus={!!seed}
          />
        </Row>
      ) : (
        <>
          <Row label="Key File">
            <div className="flex items-center gap-2">
              <Input
                className={inputCls}
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="~/.ssh/id_ed25519"
                spellCheck={false}
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => {
                  void window.pallet.ui.pickFile("Choose Private Key").then((p) => {
                    if (p) setKeyPath(p);
                  });
                }}
              >
                Choose…
              </Button>
            </div>
          </Row>
          <Row label="Passphrase">
            <Input
              className={inputCls}
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={secretPlaceholder || "Optional"}
            />
          </Row>
        </>
      )}
      <Row label="Remote Path">
        <Input
          className={inputCls}
          value={remotePathField}
          onChange={(e) => setRemotePathField(e.target.value)}
          placeholder="Optional, defaults to home"
          spellCheck={false}
        />
      </Row>
      <Row label="Local Path">
        <Input
          className={inputCls}
          value={localPathField}
          onChange={(e) => setLocalPathField(e.target.value)}
          placeholder="Optional, opens in the other pane"
          spellCheck={false}
        />
      </Row>
      <Row label="Note">
        <Input
          className={inputCls}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Row>
      <Row label="Label">
        <div className="flex items-center gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-label={`Label ${c.value}`}
              className={cn(
                "size-4 rounded-full",
                c.cls,
                colorLabel === c.value && "ring-ring ring-offset-popover ring-2 ring-offset-1",
              )}
              onClick={() => setColorLabel(c.value)}
            />
          ))}
        </div>
      </Row>

      <button
        type="button"
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 self-start text-xs"
        onClick={() => setShowAdvanced((v) => !v)}
      >
        {showAdvanced ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Advanced
      </button>
      {showAdvanced && (
        <>
          <Row label="Keepalive (s)">
            <Input
              className={cn(inputCls, "w-24")}
              value={keepalive}
              onChange={(e) => setKeepalive(e.target.value)}
            />
          </Row>
          <Row label="Concurrency">
            <div className="flex items-center gap-2">
              <Input
                className={cn(inputCls, "w-24")}
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
              />
              <span className="text-muted-foreground text-[11px]">parallel transfer channels (1–7)</span>
            </div>
          </Row>
          <Row label="Compression">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={compression}
                onChange={(e) => setCompression(e.target.checked)}
              />
              <span className="text-muted-foreground">Helps on slow links, costs CPU on fast ones</span>
            </label>
          </Row>
        </>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className="mt-1 flex items-center gap-2">
        {!editing && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void doSaveFavorite(false)}
          >
            <Star data-icon="inline-start" /> Add to Favorites
          </Button>
        )}
        {busy && (
          <span className="text-muted-foreground flex items-center gap-2 text-xs">
            <span className="border-muted-foreground/40 border-t-foreground size-3 animate-spin rounded-full border" />
            Connecting…
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setConnectOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={busy}
          >
            {editing ? "Save" : "Connect"}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function ConnectDialog(): React.JSX.Element {
  const app = useAppState();
  const editing = app.editingFavorite;

  return (
    <Dialog
      open={app.connectOpen}
      onOpenChange={(open) => {
        if (!open) setConnectOpen(false);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Favorite" : "Connect to Server"}</DialogTitle>
        </DialogHeader>
        {/* Content unmounts when closed, so per-open state seeds correctly. */}
        <ConnectForm
          paneId={app.active}
          editing={editing}
          prefill={app.connectPrefill}
        />
      </DialogContent>
    </Dialog>
  );
}
