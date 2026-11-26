import type { ConnectionProtocol } from "./sftp.types";

/** Cloud Storage's S3-compatible XML API, used with HMAC keys. */
export const GCS_ENDPOINT = "https://storage.googleapis.com";
export const GCS_REGION = "auto";

export function ftpTlsMode(protocol: ConnectionProtocol): "explicit" | "implicit" | null {
  if (protocol === "ftps") return "explicit";
  if (protocol === "ftps-implicit") return "implicit";
  return null;
}

export function isWebDav(protocol: ConnectionProtocol): boolean {
  return protocol === "webdav" || protocol === "webdavs";
}

/** Protocols whose connection has a TLS certificate check the user can relax. */
export function verifiesTls(protocol: ConnectionProtocol): boolean {
  return ftpTlsMode(protocol) !== null || protocol === "webdavs";
}
