import {
  AlertCircle,
  ChevronDown,
  Eye,
  EyeOff,
  Fingerprint,
  Info,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Server,
  Settings2,
  Star,
  UserRound,
} from "lucide-react";
import { COLOR_LABELS, LABEL_COLOR_CLASSES } from "@shared/favorite/favorite.constants";
import type { ColorLabel, Favorite, FavoriteInput, FavoriteSecret } from "@shared/favorite/favorite.types";
import type { ConnectProfile, ConnectionProtocol } from "@shared/sftp/sftp.types";
import { type PaneId, getState, pushToast, useAppState } from "@/store/pane.store";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cancelConnection, connectRemote, isCancelledConnection } from "@/store/sftp.store";
import { isWebDav, verifiesTls } from "@shared/sftp/sftp.utils";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { saveFavorite } from "@/store/favorite.store";

const PROTOCOLS: Record<ConnectionProtocol, string> = {
  sftp: "SFTP",
  ftp: "FTP",
  ftps: "FTPS",
  "ftps-implicit": "FTPS (Implicit)",
  s3: "S3",
  smb: "SMB",
  webdav: "WebDAV",
  webdavs: "WebDAVS",
};

function defaultPort(protocol: ConnectionProtocol): number {
  if (protocol === "sftp") return 22;
  if (protocol === "s3" || protocol === "webdavs") return 443;
  if (protocol === "webdav") return 80;
  if (protocol === "smb") return 445;
  if (protocol === "ftps-implicit") return 990;
  return 21;
}

function normalizeS3Endpoint(endpoint: string): string {
  if (!endpoint) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;
}

function endpointHost(endpoint: string): string | null {
  try {
    const url = new URL(normalizeS3Endpoint(endpoint));
    return url.host || null;
  } catch {
    return null;
  }
}

function validateS3Endpoint(endpoint: string): string | null {
  if (!endpoint) return null;
  let url: URL;
  try {
    url = new URL(normalizeS3Endpoint(endpoint));
  } catch {
    return "Endpoint must be a valid URL like s3.example.com";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Endpoint must start with http:// or https://";
  if (url.username || url.password) return "Endpoint can’t include credentials";
  if (url.pathname !== "/" || url.search || url.hash) return "Endpoint can’t include a path, query, or fragment";
  return null;
}

function ProtocolSelect({
  protocol,
  onProtocolChange,
  endpoint = false,
}: {
  protocol: ConnectionProtocol;
  onProtocolChange: (protocol: ConnectionProtocol) => void;
  endpoint?: boolean;
}): React.JSX.Element {
  return (
    <Select
      items={PROTOCOLS}
      value={protocol}
      onValueChange={(value) => {
        if (value) onProtocolChange(value as ConnectionProtocol);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Connection protocol"
        className={cn(
          endpoint
            ? "pallet-endpoint-protocol dark:hover:bg-muted/40 h-7 min-w-0 gap-0.5 border-transparent bg-transparent px-1 py-0 font-mono text-[11px] shadow-none data-[size=sm]:h-7 dark:bg-transparent [&>svg]:size-3"
            : "h-8 w-36 text-[13px] data-[size=sm]:h-8",
        )}
      >
        {endpoint ? <span className="text-muted-foreground">{protocol}://</span> : <SelectValue />}
      </SelectTrigger>
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        className="w-auto min-w-[92px] p-1"
      >
        {Object.entries(PROTOCOLS).map(([value, label]) => (
          <SelectItem
            key={value}
            value={value}
            className="py-1 text-xs"
          >
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Row({
  label,
  hint,
  children,
  layout = "aligned",
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  layout?: "aligned" | "stacked";
  className?: string;
}): React.JSX.Element {
  return (
    <label
      className={cn(
        layout === "stacked" ? "flex min-w-0 flex-col gap-1.5" : "grid grid-cols-[7.5rem_1fr] items-center gap-3",
        className,
      )}
    >
      <span
        className={cn(
          "text-muted-foreground flex items-center gap-1 text-[11px] font-medium",
          layout === "aligned" && "justify-end text-right",
        )}
      >
        {label}
        {hint && (
          <Tooltip>
            <TooltipTrigger
              type="button"
              delay={200}
              aria-label={`About ${label}`}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-3.5 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2"
            >
              <Info className="size-3" />
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-64 text-left leading-relaxed"
            >
              {hint}
            </TooltipContent>
          </Tooltip>
        )}
      </span>
      {children}
    </label>
  );
}

const inputCls = "h-8 text-[13px]";

/**
 * Server fields shared by the connection dialog and Edit Favorite.
 * `editing` switches it from connecting to saving; `prefill` only seeds it.
 */
export function ConnectForm({
  editing,
  creating = false,
  prefill,
  defaultConcurrency,
  defaultKeepaliveSeconds,
  autoFocus,
  onClose,
  targetPane = "right",
}: {
  editing: Favorite | null;
  /** New-favorite mode: test the connection, then save without connecting a pane. */
  creating?: boolean;
  prefill: Favorite | null;
  defaultConcurrency: number;
  defaultKeepaliveSeconds: number;
  /** Whether the form takes focus on mount. */
  autoFocus: boolean;
  /** Omitted where there is nothing to dismiss the form back to. */
  onClose?: () => void;
  /** Workspace pane a new connection replaces. */
  targetPane?: PaneId;
}): React.JSX.Element {
  const seed = editing ?? prefill;
  const seedS3 = seed?.protocol === "s3" ? seed : null;
  const initialProtocol = seed?.protocol ?? "sftp";
  const [protocol, setProtocol] = useState<ConnectionProtocol>(initialProtocol);
  const usesTls = verifiesTls(protocol);
  const [name, setName] = useState(seed?.name ?? "");
  const [server, setServer] = useState(seed?.host ?? "");
  const [port, setPort] = useState(String(seed?.port ?? defaultPort(initialProtocol)));
  const portTouched = useRef(seed ? seed.port !== defaultPort(initialProtocol) : false);
  const [username, setUsername] = useState(seed?.username ?? "");
  const [authMethod, setAuthMethod] = useState<"password" | "key" | "agent" | "s3">(
    initialProtocol === "s3" ? "s3" : initialProtocol === "sftp" ? (seed?.authMethod ?? "password") : "password",
  );
  const [password, setPassword] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [keyPath, setKeyPath] = useState(seed?.privateKeyPath ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [s3Endpoint, setS3Endpoint] = useState(seedS3?.s3Endpoint ?? "");
  const [s3Region, setS3Region] = useState(seedS3?.s3Region ?? "us-east-1");
  const [s3Bucket, setS3Bucket] = useState(seedS3?.s3Bucket ?? "");
  const [s3ForcePathStyle, setS3ForcePathStyle] = useState(seedS3?.s3ForcePathStyle ?? Boolean(seedS3?.s3Endpoint));
  const pathStyleTouched = useRef(seedS3?.s3ForcePathStyle !== undefined);
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [smbShare, setSmbShare] = useState(seed?.protocol === "smb" ? (seed.smbShare ?? "") : "");
  const [smbDomain, setSmbDomain] = useState(seed?.protocol === "smb" ? (seed.smbDomain ?? "") : "");
  const [webdavRoot, setWebdavRoot] = useState(seed && isWebDav(seed.protocol) ? (seed.webdavRoot ?? "") : "");
  const [remotePathField, setRemotePathField] = useState(seed?.remotePath ?? "");
  const [localPathField, setLocalPathField] = useState(seed?.localPath ?? "");
  const [note, setNote] = useState(seed?.note ?? "");
  const [colorLabel, setColorLabel] = useState<ColorLabel>(seed?.colorLabel ?? "none");
  const [showOptions, setShowOptions] = useState(false);
  const [showFavoriteDetails, setShowFavoriteDetails] = useState(false);
  const [keepalive, setKeepalive] = useState(String(defaultKeepaliveSeconds));
  const [compression, setCompression] = useState(false);
  const [tlsRejectUnauthorized, setTlsRejectUnauthorized] = useState(seed?.tlsRejectUnauthorized ?? true);
  const [concurrency, setConcurrency] = useState(String(defaultConcurrency));
  const [addToFavorites, setAddToFavorites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedProfileKey, setFailedProfileKey] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const connecting = useAppState().connecting;
  const connectionBlocked = !editing && connecting !== null && !busy;

  const secretPlaceholder =
    seed?.secretStored && !editing ? "Stored password" : editing?.secretStored ? "Leave blank to keep saved" : "";
  const s3SecretPlaceholder = seedS3?.secretStored ? "Leave blank to keep saved" : "";
  const s3EndpointValue = s3Endpoint.trim();
  const s3RegionValue = s3Region.trim();
  const s3RegionResolved = s3RegionValue || (s3EndpointValue ? "us-east-1" : "");

  function changeProtocol(nextProtocol: ConnectionProtocol): void {
    const currentDefault = defaultPort(protocol);
    if (!portTouched.current || port.trim() === String(currentDefault)) {
      setPort(String(defaultPort(nextProtocol)));
      portTouched.current = false;
    }
    setProtocol(nextProtocol);
    setShowSecret(false);
    if (nextProtocol === "s3") setAuthMethod("s3");
    else if (authMethod === "s3" || nextProtocol !== "sftp") setAuthMethod("password");
    setError(null);
  }

  function changeAuthMethod(nextMethod: "password" | "key" | "agent"): void {
    setShowSecret(false);
    setAuthMethod(nextMethod);
  }

  function validate(): string | null {
    if (protocol === "s3") {
      if (!s3RegionResolved) return "Region is required";
      if (!s3Bucket.trim()) return "Bucket is required";
      if (!username.trim()) return "Access key ID is required";
      if (!secretAccessKey && !(editing && seedS3?.secretStored)) return "Secret access key is required";
      const endpointError = validateS3Endpoint(s3EndpointValue);
      if (endpointError) return endpointError;
      return null;
    }
    const portNum = Number.parseInt(port, 10);
    if (!server.trim() || !username.trim()) return "Server and username are required";
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return "Port must be 1–65535";
    if (protocol === "smb" && !smbShare.trim()) return "Share is required";
    if (protocol === "smb" && /[\\/]/.test(smbShare.trim().replace(/^[\\/]+|[\\/]+$/g, ""))) {
      return "Enter only the share name, without slashes";
    }
    if (isWebDav(protocol) && /^[a-z][a-z0-9+.-]*:\/\//i.test(server.trim())) {
      return "Enter only the server name; choose WebDAV or WebDAVS for the scheme";
    }
    if (authMethod === "key" && !keyPath.trim()) return "Choose a private key file";
    if (creating && authMethod === "password" && !password) return "Password is required";
    return null;
  }

  function s3Host(): string {
    return endpointHost(s3EndpointValue) ?? `s3.${s3RegionResolved}.amazonaws.com`;
  }

  function favoriteInput(): FavoriteInput {
    if (protocol === "s3") {
      return {
        ...(editing ? { id: editing.id } : {}),
        name:
          name.trim() || `${s3Bucket.trim()} (${s3EndpointValue ? (endpointHost(s3EndpointValue) ?? s3EndpointValue) : "AWS"})`,
        protocol: "s3",
        host: s3Host(),
        port: 443,
        username: username.trim(),
        authMethod: "s3",
        ...(s3EndpointValue ? { s3Endpoint: normalizeS3Endpoint(s3EndpointValue) } : {}),
        s3Region: s3RegionResolved,
        s3Bucket: s3Bucket.trim(),
        s3ForcePathStyle,
        ...(remotePathField.trim() ? { remotePath: remotePathField.trim() } : {}),
        ...(localPathField.trim() ? { localPath: localPathField.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        colorLabel,
      };
    }
    return {
      ...(editing ? { id: editing.id } : {}),
      name: name.trim() || `${username.trim()}@${server.trim()}`,
      protocol,
      host: server.trim(),
      port: Number.parseInt(port, 10),
      username: username.trim(),
      authMethod,
      ...(authMethod === "key" && keyPath.trim() ? { privateKeyPath: keyPath.trim() } : {}),
      ...(usesTls ? { tlsRejectUnauthorized } : {}),
      ...(protocol === "smb"
        ? { smbShare: smbShare.trim(), ...(smbDomain.trim() ? { smbDomain: smbDomain.trim() } : {}) }
        : {}),
      ...(isWebDav(protocol) && webdavRoot.trim() ? { webdavRoot: webdavRoot.trim() } : {}),
      ...(remotePathField.trim() ? { remotePath: remotePathField.trim() } : {}),
      ...(localPathField.trim() ? { localPath: localPathField.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      colorLabel,
    };
  }

  function enteredSecret(): FavoriteSecret | undefined {
    if (protocol === "s3") {
      if (!secretAccessKey) return undefined;
      return { secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
    }
    const secret = authMethod === "password" ? password : authMethod === "key" ? passphrase : "";
    return secret.length > 0 ? secret : undefined;
  }

  function buildProfile(): ConnectProfile {
    const keepaliveSeconds = Number.parseInt(keepalive, 10);
    return protocol === "s3"
      ? {
          protocol: "s3",
          host: s3Host(),
          port: 443,
          username: username.trim(),
          auth: { method: "s3", secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
          s3: {
            ...(s3EndpointValue ? { endpoint: normalizeS3Endpoint(s3EndpointValue) } : {}),
            region: s3RegionResolved,
            bucket: s3Bucket.trim(),
            forcePathStyle: s3ForcePathStyle,
          },
          ...(remotePathField.trim() ? { remotePath: remotePathField.trim() } : {}),
          concurrency: Number.parseInt(concurrency, 10) || defaultConcurrency,
        }
      : {
          protocol,
          host: server.trim(),
          port: Number.parseInt(port, 10),
          username: username.trim(),
          auth:
            authMethod === "password"
              ? { method: "password", password }
              : authMethod === "key"
                ? { method: "key", keyPath: keyPath.trim(), ...(passphrase ? { passphrase } : {}) }
                : { method: "agent" },
          ...(remotePathField.trim() ? { remotePath: remotePathField.trim() } : {}),
          keepaliveIntervalMs:
            Math.max(0, Number.isFinite(keepaliveSeconds) ? keepaliveSeconds : defaultKeepaliveSeconds) * 1000,
          compression,
          ...(usesTls ? { tlsRejectUnauthorized } : {}),
          ...(protocol === "smb"
            ? { smb: { share: smbShare.trim(), ...(smbDomain.trim() ? { domain: smbDomain.trim() } : {}) } }
            : {}),
          ...(isWebDav(protocol) && webdavRoot.trim() ? { webdav: { root: webdavRoot.trim() } } : {}),
          concurrency: Number.parseInt(concurrency, 10) || defaultConcurrency,
        };
  }

  async function doConnect(): Promise<void> {
    const pending = getState().connecting;
    if (pending) {
      setError(`Connecting to ${pending.label} — wait for it to finish`);
      return;
    }
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await connectRemote(buildProfile(), targetPane === "right" ? localPathField.trim() || undefined : undefined, targetPane);
      if (addToFavorites) {
        const saved = await saveFavorite(favoriteInput(), enteredSecret());
        if (saved) pushToast(`Added “${saved.name}” to Favorites`, "info");
      }
    } catch (err) {
      setBusy(false);
      if (!isCancelledConnection(err)) setError((err as Error).message);
    }
  }

  async function doSaveFavorite(): Promise<void> {
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    const profileKey = creating ? JSON.stringify(buildProfile()) : null;
    const testing = creating && profileKey !== failedProfileKey;
    setBusy(true);
    setError(null);
    try {
      if (testing) {
        try {
          await window.pallet.favorites.test(buildProfile());
        } catch (err) {
          if (!mounted.current) return;
          setBusy(false);
          setFailedProfileKey(profileKey);
          setError((err as Error).message);
          return;
        }
        if (!mounted.current) return;
        setFailedProfileKey(null);
      }
      const saved = await saveFavorite(favoriteInput(), enteredSecret());
      if (!mounted.current) return;
      if (saved) {
        pushToast(creating ? `Added “${saved.name}” to Favorites` : "Favorite saved", "info");
        onClose?.();
      } else {
        setBusy(false);
      }
    } catch (err) {
      if (!mounted.current) return;
      setBusy(false);
      setError((err as Error).message);
    }
  }

  const isPane = editing === null && !creating;
  const saveAnyway = creating && failedProfileKey !== null && failedProfileKey === JSON.stringify(buildProfile());
  const fieldLayout = isPane ? "stacked" : "aligned";
  const fieldInputCls = inputCls;
  const authPicker = (
    <div
      className="pallet-auth-picker flex h-8 rounded-full bg-black/[0.04] p-0.5 ring-1 ring-black/[0.04] ring-inset dark:bg-black/20 dark:ring-white/[0.05]"
      role="group"
      aria-label="Authentication method"
    >
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className={cn(
          "h-7 flex-1 rounded-full px-2 text-xs",
          authMethod === "password"
            ? "text-foreground bg-white shadow-[0_1px_2px_rgb(0_0_0/0.10)] ring-1 ring-black/[0.04] dark:bg-white/[0.13] dark:shadow-none dark:ring-white/[0.06]"
            : "text-muted-foreground hover:text-foreground hover:bg-black/[0.03] dark:hover:bg-white/[0.05]",
        )}
        aria-pressed={authMethod === "password"}
        onClick={() => changeAuthMethod("password")}
      >
        <LockKeyhole data-icon="inline-start" /> Password
      </Button>
      {protocol === "sftp" && (
        <>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className={cn(
              "h-7 flex-1 rounded-full px-2 text-xs",
              authMethod === "key"
                ? "text-foreground bg-white shadow-[0_1px_2px_rgb(0_0_0/0.10)] ring-1 ring-black/[0.04] dark:bg-white/[0.13] dark:shadow-none dark:ring-white/[0.06]"
                : "text-muted-foreground hover:text-foreground hover:bg-black/[0.03] dark:hover:bg-white/[0.05]",
            )}
            aria-pressed={authMethod === "key"}
            onClick={() => changeAuthMethod("key")}
          >
            <KeyRound data-icon="inline-start" />
            <span>
              <span className="pallet-private-key-prefix">Private </span>Key
            </span>
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className={cn(
              "h-7 flex-1 rounded-full px-2 text-xs",
              authMethod === "agent"
                ? "text-foreground bg-white shadow-[0_1px_2px_rgb(0_0_0/0.10)] ring-1 ring-black/[0.04] dark:bg-white/[0.13] dark:shadow-none dark:ring-white/[0.06]"
                : "text-muted-foreground hover:text-foreground hover:bg-black/[0.03] dark:hover:bg-white/[0.05]",
            )}
            aria-pressed={authMethod === "agent"}
            onClick={() => changeAuthMethod("agent")}
          >
            <Fingerprint data-icon="inline-start" />
            <span>SSH Agent</span>
          </Button>
        </>
      )}
    </div>
  );

  const smbShareRow = (
    <Row
      label="Share"
      hint="Name of the shared folder on the server, e.g. Public. Leave out the server name and slashes."
      layout={fieldLayout}
    >
      <Input
        className={fieldInputCls}
        value={smbShare}
        onChange={(e) => setSmbShare(e.target.value)}
        placeholder="Public"
        spellCheck={false}
      />
    </Row>
  );
  const smbDomainRow = (
    <Row
      label="Domain"
      hint="Windows domain or workgroup. Leave blank for most home and NAS servers."
      layout={fieldLayout}
    >
      <Input
        className={fieldInputCls}
        value={smbDomain}
        onChange={(e) => setSmbDomain(e.target.value)}
        placeholder="Optional"
        spellCheck={false}
      />
    </Row>
  );

  const webdavRootRow = (
    <Row
      label="Server Path"
      hint={
        protocol === "webdav"
          ? "WebDAV folder URL path, e.g. /remote.php/dav/files/alice for Nextcloud. Plain WebDAV sends your password unencrypted; use WebDAVS when the server supports it."
          : "WebDAV folder URL path, e.g. /remote.php/dav/files/alice for Nextcloud. Leave blank for the server root."
      }
      layout={fieldLayout}
    >
      <Input
        className={fieldInputCls}
        value={webdavRoot}
        onChange={(e) => setWebdavRoot(e.target.value)}
        placeholder="Optional, defaults to /"
        spellCheck={false}
      />
    </Row>
  );

  const s3Fields = (
    <>
      <Row
        label="Endpoint"
        hint="Hostname of your S3-compatible provider, e.g. s3.example.com. Leave blank for AWS S3."
        layout={fieldLayout}
      >
        <div className="flex flex-col gap-1">
          <Input
            className={fieldInputCls}
            value={s3Endpoint}
            onChange={(e) => {
              const value = e.target.value;
              setS3Endpoint(value);
              // Custom endpoints nearly always need path-style addressing; AWS does not.
              if (value.trim()) setS3ForcePathStyle(true);
              else if (!pathStyleTouched.current) setS3ForcePathStyle(false);
            }}
            placeholder="AWS S3"
            spellCheck={false}
            autoFocus={autoFocus && !seed}
          />
          {/^http:\/\//i.test(s3EndpointValue) && (
            <p
              className="text-destructive text-[11px]"
              role="alert"
            >
              Credentials and data would travel without TLS.
            </p>
          )}
        </div>
      </Row>
      <Row
        label="Region"
        hint="Required for AWS S3. With a custom endpoint you can leave this blank. us-east-1 is used by default."
        layout={fieldLayout}
      >
        <Input
          className={fieldInputCls}
          value={s3Region}
          onChange={(e) => setS3Region(e.target.value)}
          placeholder="us-east-1"
          spellCheck={false}
        />
      </Row>
      <Row
        label="Bucket"
        hint="Name of the existing bucket."
        layout={fieldLayout}
      >
        <Input
          className={fieldInputCls}
          value={s3Bucket}
          onChange={(e) => setS3Bucket(e.target.value)}
          placeholder="my-bucket"
          spellCheck={false}
        />
      </Row>
      <Row
        label="Access Key ID"
        hint="Access key ID from your S3 credentials. AWS keys usually start with AKIA."
        layout={fieldLayout}
      >
        <Input
          className={fieldInputCls}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="AKIA…"
          spellCheck={false}
          autoCapitalize="off"
        />
      </Row>
      <Row
        label="Secret Access Key"
        hint="Secret access key that pairs with the access key ID."
        layout={fieldLayout}
      >
        <Input
          className={fieldInputCls}
          type="password"
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
          placeholder={s3SecretPlaceholder}
          autoFocus={isPane && autoFocus && !!seed}
        />
      </Row>
      <Row
        label="Session Token"
        hint="Optional token for temporary credentials. Leave blank when using long-lived access keys."
        layout={fieldLayout}
      >
        <Input
          className={fieldInputCls}
          type="password"
          value={sessionToken}
          onChange={(e) => setSessionToken(e.target.value)}
          placeholder="Optional"
        />
      </Row>
    </>
  );

  return (
    <form
      className="pallet-connect-form flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (editing || creating) void doSaveFavorite();
        else void doConnect();
      }}
    >
      {isPane ? (
        protocol === "s3" ? (
          <>
            <Row
              label="Protocol"
              layout="stacked"
            >
              <ProtocolSelect
                protocol={protocol}
                onProtocolChange={changeProtocol}
              />
            </Row>
            {s3Fields}
          </>
        ) : (
          <>
            <div
              className="pallet-endpoint-control group border-input focus-within:border-primary focus-within:ring-primary/25 dark:bg-input/30 flex h-8 items-center rounded-lg border bg-white px-2.5 transition-[border-color,box-shadow] focus-within:ring-2"
              role="group"
              aria-label="Server endpoint"
            >
              <Server className="text-muted-foreground group-focus-within:text-primary mr-1.5 size-3.5 shrink-0 transition-colors" />
              <ProtocolSelect
                protocol={protocol}
                onProtocolChange={changeProtocol}
                endpoint
              />
              <input
                className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent px-1.5 text-[13px] outline-none"
                aria-label="Server"
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="example.com"
                spellCheck={false}
                autoFocus={autoFocus && !seed}
              />
              <div className="border-border/80 flex h-4 shrink-0 items-center border-l pl-2">
                <span className="text-muted-foreground font-mono text-[11px]">:</span>
                <input
                  className="text-foreground w-9 bg-transparent text-center font-mono text-[11px] tabular-nums outline-none"
                  aria-label="Port"
                  value={port}
                  onChange={(e) => {
                    portTouched.current = true;
                    setPort(e.target.value);
                  }}
                  spellCheck={false}
                />
              </div>
            </div>

            {protocol === "sftp" && authPicker}

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
              {authMethod === "agent" ? (
                <Row
                  label="SSH Agent"
                  layout="stacked"
                >
                  <div className="text-muted-foreground flex h-9 items-center gap-2 text-xs">
                    <Fingerprint className="size-3.5 shrink-0" />
                    <span>Uses SSH_AUTH_SOCK, including 1Password</span>
                  </div>
                </Row>
              ) : (
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
                      className={cn(fieldInputCls, "pr-8 pl-8")}
                      aria-label={authMethod === "password" ? "Password" : "Passphrase"}
                      autoComplete={authMethod === "password" ? "current-password" : "off"}
                      type={showSecret ? "text" : "password"}
                      value={authMethod === "password" ? password : passphrase}
                      onChange={(e) =>
                        authMethod === "password" ? setPassword(e.target.value) : setPassphrase(e.target.value)
                      }
                      placeholder={authMethod === "key" ? secretPlaceholder || "Optional" : secretPlaceholder}
                      autoFocus={autoFocus && !!seed}
                    />
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 absolute top-1/2 right-0.5 size-7 -translate-y-1/2 rounded-[6px] transition-colors duration-[140ms] outline-none hover:bg-black/[0.05] focus-visible:ring-2 dark:hover:bg-white/[0.08]"
                      aria-label={
                        showSecret
                          ? `Hide ${authMethod === "key" ? "passphrase" : "password"}`
                          : `Show ${authMethod === "key" ? "passphrase" : "password"}`
                      }
                      aria-pressed={showSecret}
                      onClick={() => setShowSecret((value) => !value)}
                    >
                      {showSecret ? <EyeOff className="mx-auto size-3.5" /> : <Eye className="mx-auto size-3.5" />}
                    </button>
                  </div>
                </Row>
              )}
            </div>

            {protocol === "smb" && (
              <div className="grid grid-cols-2 gap-2.5">
                {smbShareRow}
                {smbDomainRow}
              </div>
            )}

            {isWebDav(protocol) && webdavRootRow}

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
        )
      ) : (
        <>
          <Row label="Name">
            <Input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                protocol === "s3"
                  ? `${s3Bucket || "bucket"} (${s3EndpointValue ? (endpointHost(s3EndpointValue) ?? s3EndpointValue) : "AWS"})`
                  : `${username || "user"}@${server || "host"}`
              }
            />
          </Row>
          <Row label="Protocol">
            <ProtocolSelect
              protocol={protocol}
              onProtocolChange={changeProtocol}
            />
          </Row>
          {protocol === "s3" ? (
            s3Fields
          ) : (
            <>
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
                  onChange={(e) => {
                    portTouched.current = true;
                    setPort(e.target.value);
                  }}
                  spellCheck={false}
                />
              </Row>
              {protocol === "smb" && (
                <>
                  {smbShareRow}
                  {smbDomainRow}
                </>
              )}
              {isWebDav(protocol) && webdavRootRow}
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
              ) : authMethod === "agent" ? (
                <Row label="SSH Agent">
                  <span className="text-muted-foreground text-xs">Uses SSH_AUTH_SOCK, including 1Password</span>
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
        </>
      )}

      <div className={cn("grid gap-2", isPane && "pallet-disclosure-grid grid-cols-2")}>
        <button
          type="button"
          className="border-border/80 text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex h-8 items-center justify-between rounded-[8px] border bg-black/[0.03] px-2.5 text-left text-xs transition-colors duration-[140ms] outline-none hover:bg-black/[0.06] focus-visible:ring-2 dark:bg-white/[0.035] dark:hover:bg-white/[0.06]"
          aria-label="Connection options"
          aria-expanded={showOptions}
          onClick={() => setShowOptions((value) => !value)}
        >
          <span className="flex items-center gap-1.5">
            <Settings2 className="size-3.5" />
            <span className="text-foreground font-medium">Options</span>
          </span>
          <ChevronDown
            className={cn("ease-onscreen size-3.5 transition-transform duration-[150ms]", showOptions && "rotate-180")}
          />
        </button>
        {isPane && (
          <button
            type="button"
            className="border-border/80 text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex h-8 items-center justify-between rounded-[8px] border bg-black/[0.03] px-2.5 text-left text-xs transition-colors duration-[140ms] outline-none hover:bg-black/[0.06] focus-visible:ring-2 dark:bg-white/[0.035] dark:hover:bg-white/[0.06]"
            aria-label="Favorite details"
            aria-expanded={showFavoriteDetails}
            onClick={() => setShowFavoriteDetails((value) => !value)}
          >
            <span className="flex items-center gap-1.5">
              <Star className="size-3.5" />
              <span className="text-foreground font-medium">Favorite</span>
            </span>
            <ChevronDown
              className={cn(
                "ease-onscreen size-3.5 transition-transform duration-[150ms]",
                showFavoriteDetails && "rotate-180",
              )}
            />
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
            label={protocol === "s3" ? "Prefix" : "Remote Path"}
            hint={
              protocol === "s3"
                ? "Optional key prefix to open as the pane's root. Leave blank to start at the bucket root."
                : undefined
            }
            layout={fieldLayout}
            className={cn(isPane && "pallet-options-span col-span-2")}
          >
            <Input
              className={fieldInputCls}
              value={remotePathField}
              onChange={(e) => setRemotePathField(e.target.value)}
              placeholder={
                protocol === "s3"
                  ? "Optional starting prefix"
                  : protocol === "smb"
                    ? "Optional, defaults to the share root"
                    : isWebDav(protocol)
                      ? "Optional, defaults to the server path"
                      : "Optional, defaults to home"
              }
              spellCheck={false}
            />
          </Row>
          {protocol === "s3" && (
            <Row
              label="Addressing"
              hint="Path-style puts the bucket in the URL path instead of the hostname. Most custom endpoints need this; AWS S3 works either way."
              layout={fieldLayout}
              className={cn(isPane && "pallet-options-span col-span-2")}
            >
              <div className="flex items-center gap-2 text-xs">
                <Checkbox
                  aria-label="Path-style addressing"
                  checked={s3ForcePathStyle}
                  onCheckedChange={(checked) => {
                    pathStyleTouched.current = true;
                    setS3ForcePathStyle(checked);
                  }}
                />
                <span className="text-muted-foreground">Path-style addressing (needed by most custom endpoints)</span>
              </div>
            </Row>
          )}
          {!(isPane && targetPane === "left") && (
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
          )}
          {protocol === "sftp" && (
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
          )}
          <Row
            label="Concurrency"
            layout={fieldLayout}
            className={cn(isPane && protocol !== "sftp" && "pallet-options-span col-span-2")}
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
          {protocol === "sftp" && (
            <Row
              label="Compression"
              layout={fieldLayout}
              className={cn(isPane && "pallet-options-span col-span-2")}
            >
              <div className="flex items-center gap-2 text-xs">
                <Checkbox
                  aria-label="Enable SFTP compression"
                  checked={compression}
                  onCheckedChange={setCompression}
                />
                <span className="text-muted-foreground">Helps on slow links, costs CPU on fast ones</span>
              </div>
            </Row>
          )}
          {usesTls && (
            <Row
              label="TLS Security"
              layout={fieldLayout}
              className={cn(isPane && "pallet-options-span col-span-2")}
            >
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <Checkbox
                    aria-label="Verify TLS certificate"
                    checked={tlsRejectUnauthorized}
                    onCheckedChange={setTlsRejectUnauthorized}
                  />
                  <span className="text-foreground">Verify TLS certificate</span>
                </div>
                {!tlsRejectUnauthorized && (
                  <p
                    className="text-destructive text-[11px]"
                    role="alert"
                  >
                    Untrusted certificates will be accepted. Use only with a server you trust.
                  </p>
                )}
              </div>
            </Row>
          )}
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
            <div className="flex h-8 items-center gap-2">
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
        <div
          className={cn(
            "border-destructive/25 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-2.5 py-2 text-[12px] leading-snug",
            !isPane && "border-0 bg-transparent px-0 py-0",
          )}
          role="alert"
        >
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      <div className="border-border/70 mt-0.5 flex items-center justify-end gap-2 border-t pt-3">
        {isPane && (
          <div className="mr-auto flex items-center gap-2">
            <Switch
              id="connect-add-favorite"
              aria-label="Add to Favorites"
              aria-describedby="connect-add-favorite-hint"
              checked={addToFavorites}
              disabled={busy}
              onCheckedChange={setAddToFavorites}
            />
            <div className="flex flex-col">
              <label
                htmlFor="connect-add-favorite"
                className="text-foreground text-xs font-medium"
              >
                Add to Favorites
              </label>
              <span
                id="connect-add-favorite-hint"
                className="text-muted-foreground text-[11px]"
              >
                After a successful connection
              </span>
            </div>
          </div>
        )}
        {onClose && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-[13px]"
            disabled={busy && !isPane}
            onClick={isPane && busy ? cancelConnection : onClose}
            title={isPane && busy ? "Stop connecting" : undefined}
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          className={cn("h-8 text-[13px]", isPane && "min-w-[84px]")}
          disabled={busy || connectionBlocked}
          aria-busy={busy}
          title={connectionBlocked ? "A connection is already opening" : undefined}
        >
          {(busy || connectionBlocked) && (
            <LoaderCircle
              className="animate-spin"
              data-icon="inline-start"
            />
          )}
          {editing
            ? busy
              ? "Saving…"
              : "Save"
            : creating
              ? saveAnyway
                ? "Save Anyway"
                : "Save"
              : busy || connectionBlocked
                ? "Connecting…"
                : "Connect"}
        </Button>
      </div>
    </form>
  );
}
