import type { ConnectionProtocol } from "./sftp.types";

export function ftpTlsMode(protocol: ConnectionProtocol): "explicit" | "implicit" | null {
  if (protocol === "ftps") return "explicit";
  if (protocol === "ftps-implicit") return "implicit";
  return null;
}

/** Protocols carried over an SSH connection (shared auth, host keys, terminal). */
export function isSsh(protocol: ConnectionProtocol): boolean {
  return protocol === "sftp" || protocol === "scp";
}

export function isWebDav(protocol: ConnectionProtocol): boolean {
  return protocol === "webdav" || protocol === "webdavs";
}

/** Protocols whose connection has a TLS certificate check the user can relax. */
export function verifiesTls(protocol: ConnectionProtocol): boolean {
  return ftpTlsMode(protocol) !== null || protocol === "webdavs";
}
