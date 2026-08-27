import { COLOR_LABELS, LABEL_COLOR_CLASSES } from "@shared/favorite/favorite.constants";
import { ChevronDown, KeyRound, LoaderCircle, LockKeyhole, Server, Settings2, Star, UserRound } from "lucide-react";
import type { ColorLabel, Favorite, FavoriteInput } from "@shared/favorite/favorite.types";
import { Button } from "@/components/ui/button";
import type { ConnectProfile } from "@shared/sftp/sftp.types";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { connectRemote } from "@/store/sftp.store";
import { pushToast } from "@/store/pane.store";
import { saveFavorite } from "@/store/favorite.store";
import { useState } from "react";

function Row({
  label,
  children,
  layout = "aligned",
  className,
}: {
  label: string;
  children: React.ReactNode;
  layout?: "aligned" | "stacked";
  className?: string;
}): React.JSX.Element {
  return (
    <label
      className={cn(
        layout === "stacked" ? "flex min-w-0 flex-col gap-1.5" : "grid grid-cols-[7rem_1fr] items-center gap-3",
        className,
      )}
    >
      <span className={cn("text-muted-foreground text-xs", layout === "stacked" ? "font-medium" : "text-right")}>{label}</span>
      {children}
    </label>
  );
}

const inputCls = "h-7 text-[13px]";

/**
 * Server fields shared by the connection dialog and Edit Favorite.
 * `editing` switches it from connecting to saving; `prefill` only seeds it.
 */
export function ConnectForm({
  editing,
  prefill,
  defaultConcurrency,
  autoFocus,
  onClose,
}: {
  editing: Favorite | null;
  prefill: Favorite | null;
  defaultConcurrency: number;
  /** Whether the form takes focus on mount. */
  autoFocus: boolean;
  /** Omitted where there is nothing to dismiss the form back to. */
  onClose?: () => void;
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
  const [showOptions, setShowOptions] = useState(false);
  const [showFavoriteDetails, setShowFavoriteDetails] = useState(false);
  const [keepalive, setKeepalive] = useState("15");
  const [compression, setCompression] = useState(false);
  const [concurrency, setConcurrency] = useState(String(defaultConcurrency));
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
      concurrency: Number.parseInt(concurrency, 10) || defaultConcurrency,
    };
    setBusy(true);
    setError(null);
    try {
      await connectRemote(profile, localPathField.trim() || undefined);
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
      if (close) onClose?.();
    }
  }

  const isPane = editing === null;
  const fieldLayout = isPane ? "stacked" : "aligned";
  const fieldInputCls = cn(inputCls, isPane && "h-9");
  const authPicker = (
    <div
      className="pallet-auth-picker bg-muted/40 flex rounded-md p-0.5"
      role="group"
      aria-label="Authentication method"
    >
      <Button
        type="button"
        size="xs"
        variant={authMethod === "password" ? "secondary" : "ghost"}
        className="flex-1"
        aria-pressed={authMethod === "password"}
        onClick={() => setAuthMethod("password")}
      >
        <LockKeyhole data-icon="inline-start" /> Password
      </Button>
      <Button
        type="button"
        size="xs"
        variant={authMethod === "key" ? "secondary" : "ghost"}
        className="flex-1"
        aria-pressed={authMethod === "key"}
        onClick={() => setAuthMethod("key")}
      >
        <KeyRound data-icon="inline-start" />
        <span>
          <span className="pallet-private-key-prefix">Private </span>Key
        </span>
      </Button>
    </div>
  );

  return (
    <form
      className="pallet-connect-form flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (editing) void doSaveFavorite(true);
        else void doConnect();
      }}
    >
      {isPane ? (
        <>
          <div
            className="pallet-endpoint-control border-input bg-background/55 focus-within:border-primary focus-within:ring-primary/20 flex h-11 items-center rounded-lg border px-3 transition-[border-color,box-shadow] focus-within:ring-3"
            role="group"
            aria-label="Server endpoint"
          >
            <Server className="text-primary mr-2 size-4 shrink-0" />
            <span className="pallet-endpoint-protocol text-muted-foreground font-mono text-[11px]">sftp://</span>
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent px-1.5 text-[13px] outline-none"
              aria-label="Server"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="example.com"
              spellCheck={false}
              autoFocus={autoFocus && !seed}
            />
            <div className="border-border/80 flex h-5 shrink-0 items-center border-l pl-2">
              <span className="text-muted-foreground font-mono text-xs">:</span>
              <input
                className="text-foreground w-10 bg-transparent text-center font-mono text-xs tabular-nums outline-none"
                aria-label="Port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>

          {authPicker}

          <div className="pallet-credentials-grid grid grid-cols-2 gap-2.5">
            <Row
              label="Username"
              layout="stacked"
            >
              <div className="relative">
                <UserRound className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                <Input
                  className={cn(fieldInputCls, "pl-8")}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                />
              </div>
            </Row>
            <Row
              label={authMethod === "password" ? "Password" : "Passphrase"}
              layout="stacked"
            >
              <div className="relative">
                {authMethod === "password" ? (
                  <LockKeyhole className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                ) : (
                  <KeyRound className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                )}
                <Input
                  className={cn(fieldInputCls, "pl-8")}
                  type="password"
                  value={authMethod === "password" ? password : passphrase}
                  onChange={(e) => (authMethod === "password" ? setPassword(e.target.value) : setPassphrase(e.target.value))}
                  placeholder={authMethod === "key" ? secretPlaceholder || "Optional" : secretPlaceholder}
                  autoFocus={autoFocus && !!seed}
                />
              </div>
            </Row>
          </div>

          {authMethod === "key" && (
            <Row
              label="Private key"
              layout="stacked"
            >
              <div className="flex items-center gap-2">
                <Input
                  className={fieldInputCls}
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  size="sm"
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
          )}
        </>
      ) : (
        <>
          <Row label="Name">
            <Input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${username || "user"}@${server || "host"}`}
            />
          </Row>
          <Row label="Server">
            <Input
              className={inputCls}
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="example.com"
              spellCheck={false}
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
              autoFocus={autoFocus}
            />
          </Row>
          <Row label="Authenticate">{authPicker}</Row>
          {authMethod === "password" ? (
            <Row label="Password">
              <Input
                className={inputCls}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={secretPlaceholder}
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
        </>
      )}

      <div className={cn("grid gap-2", isPane && "pallet-disclosure-grid grid-cols-2")}>
        <button
          type="button"
          className="border-border/80 bg-background/25 text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-ring/50 flex h-9 items-center justify-between rounded-lg border px-2.5 text-left text-xs transition-colors outline-none focus-visible:ring-2"
          aria-label="Connection options"
          aria-expanded={showOptions}
          onClick={() => setShowOptions((value) => !value)}
        >
          <span className="flex items-center gap-1.5">
            <Settings2 className="size-3.5" />
            <span className="text-foreground font-medium">Options</span>
          </span>
          <ChevronDown className={cn("size-3.5 transition-transform", showOptions && "rotate-180")} />
        </button>
        {isPane && (
          <button
            type="button"
            className="border-border/80 bg-background/25 text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-ring/50 flex h-9 items-center justify-between rounded-lg border px-2.5 text-left text-xs transition-colors outline-none focus-visible:ring-2"
            aria-label="Favorite details"
            aria-expanded={showFavoriteDetails}
            onClick={() => setShowFavoriteDetails((value) => !value)}
          >
            <span className="flex items-center gap-1.5">
              <Star className="size-3.5" />
              <span className="text-foreground font-medium">Favorite</span>
            </span>
            <ChevronDown className={cn("size-3.5 transition-transform", showFavoriteDetails && "rotate-180")} />
          </button>
        )}
      </div>

      {showOptions && (
        <div
          className={cn(
            "border-border/70 border-t pt-3",
            isPane ? "pallet-options-grid grid grid-cols-2 gap-3" : "flex flex-col gap-2.5",
          )}
        >
          <Row
            label="Remote Path"
            layout={fieldLayout}
            className={cn(isPane && "pallet-options-span col-span-2")}
          >
            <Input
              className={fieldInputCls}
              value={remotePathField}
              onChange={(e) => setRemotePathField(e.target.value)}
              placeholder="Optional, defaults to home"
              spellCheck={false}
            />
          </Row>
          <Row
            label="Local Path"
            layout={fieldLayout}
            className={cn(isPane && "pallet-options-span col-span-2")}
          >
            <Input
              className={fieldInputCls}
              value={localPathField}
              onChange={(e) => setLocalPathField(e.target.value)}
              placeholder="Optional, opens in the left pane"
              spellCheck={false}
            />
          </Row>
          <Row
            label="Keepalive (s)"
            layout={fieldLayout}
          >
            <Input
              className={cn(fieldInputCls, !isPane && "w-24")}
              value={keepalive}
              onChange={(e) => setKeepalive(e.target.value)}
            />
          </Row>
          <Row
            label="Concurrency"
            layout={fieldLayout}
          >
            <div className="flex items-center gap-2">
              <Input
                className={cn(fieldInputCls, !isPane && "w-24")}
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
              />
              {!isPane && <span className="text-muted-foreground text-[11px]">parallel transfer channels (1–7)</span>}
            </div>
          </Row>
          <Row
            label="Compression"
            layout={fieldLayout}
            className={cn(isPane && "pallet-options-span col-span-2")}
          >
            <div className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={compression}
                onChange={(e) => setCompression(e.target.checked)}
              />
              <span className="text-muted-foreground">Helps on slow links, costs CPU on fast ones</span>
            </div>
          </Row>
        </div>
      )}

      {(editing || showFavoriteDetails) && (
        <div
          className={cn(
            "border-border/70 border-t pt-3",
            isPane ? "pallet-favorite-grid grid grid-cols-[1fr_auto] items-end gap-3" : "flex flex-col gap-2.5",
          )}
        >
          <Row
            label="Note"
            layout={fieldLayout}
          >
            <Input
              className={fieldInputCls}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Row>
          <Row
            label="Label"
            layout={fieldLayout}
          >
            <div className="flex h-9 items-center gap-2">
              {COLOR_LABELS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={`Label ${value}`}
                  aria-pressed={colorLabel === value}
                  className={cn(
                    "focus-visible:ring-ring size-4 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                    LABEL_COLOR_CLASSES[value],
                    colorLabel === value && "ring-ring ring-offset-popover ring-2 ring-offset-1",
                  )}
                  onClick={() => setColorLabel(value)}
                />
              ))}
            </div>
          </Row>
        </div>
      )}

      {error && (
        <p
          className={cn("text-destructive text-xs", isPane && "bg-destructive/10 rounded-md px-3 py-2")}
          role="alert"
        >
          {error}
        </p>
      )}

      <div className="border-border/70 mt-0.5 flex items-center justify-end gap-2 border-t pt-3">
        {onClose && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
        )}
        {isPane && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            disabled={busy}
            aria-label="Add to Favorites"
            onClick={() => void doSaveFavorite(false)}
          >
            <Star data-icon="inline-start" />
            <span>
              <span className="pallet-add-favorite-prefix">Add to </span>Favorites
            </span>
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          className={cn(isPane && "h-9 min-w-24")}
          disabled={busy}
        >
          {busy && (
            <LoaderCircle
              className="animate-spin"
              data-icon="inline-start"
            />
          )}
          {editing ? "Save" : busy ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </form>
  );
}
