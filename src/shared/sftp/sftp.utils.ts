import type { ConnectionProtocol } from "./sftp.types";

export function ftpTlsMode(protocol: ConnectionProtocol): "explicit" | "implicit" | null {
  if (protocol === "ftps") return "explicit";
  if (protocol === "ftps-implicit") return "implicit";
  return null;
}
