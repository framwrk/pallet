/**
 * Scrub credentials from anything on its way to the log file (§7).
 *
 * Nothing in Pallet deliberately logs a secret, but stack traces and error
 * messages are written verbatim and can carry a URL with an inline password
 * or a `password: "…"` fragment from a config object. Redaction is the belt
 * to that suspenders — cheap, and the failure mode it prevents (a password
 * sitting in a log the user then attaches to a GitHub issue) is permanent.
 */

const PATTERNS: { re: RegExp; replace: string }[] = [
  // scheme://user:secret@host  →  scheme://user:***@host
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+):[^\s/@]*@/gi, replace: "$1:***@" },
  // password=secret, "passphrase": "secret", password: secret
  {
    // The optional quote is captured, not swallowed, so `"passphrase": "x"`
    // keeps its closing quote and stays valid-looking JSON in the log.
    re: /\b(password|passphrase|passwd|secret|token|api[_-]?key)\b("?)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    replace: "$1$2$3***",
  },
  // PEM private key bodies
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: "-----BEGIN PRIVATE KEY----- *** -----END PRIVATE KEY-----",
  },
];

export function redact(text: string): string {
  let out = text;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}
