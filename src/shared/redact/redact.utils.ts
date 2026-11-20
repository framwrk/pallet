const PATTERNS: { re: RegExp; replace: string }[] = [
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+):[^\s/@]*@/gi, replace: "$1:***@" },
  { re: /\b(authorization)("?)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n]+)/gi, replace: "$1$2$3***" },
  {
    re: /\b(password|passphrase|passwd|secret|secret[_-]?access[_-]?key|session[_-]?token|token|x-amz-security-token|x-amz-signature|api[_-]?key)\b("?)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    replace: "$1$2$3***",
  },
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
