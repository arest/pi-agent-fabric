/**
 * Redact secret-like substrings from untrusted text before surfacing or persisting it.
 *
 * This is intentionally heuristic and fail-closed for common token formats used by
 * GitHub/OpenAI/cloud APIs and key=value secret payloads.
 */

export const REDACTED = "[REDACTED]";

const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi,
  /\bsk-(?:test|live|proj|svc|org|[a-z0-9]{2,})-[A-Za-z0-9]{16,}\b/gi,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[pbars]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})\b/g,
];

const KEY_VALUE_SECRET = /(\b(?:token|secret|password|passwd|api[_-]?key|access[_-]?key)\b\s*[:=]\s*)([^\s,;]+)/gi;
const URL_CREDENTIALS = /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;

export function redactSecrets(value: string): string {
  let redacted = value;
  for (const pattern of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  redacted = redacted.replace(KEY_VALUE_SECRET, `$1${REDACTED}`);
  redacted = redacted.replace(URL_CREDENTIALS, `$1${REDACTED}:${REDACTED}@`);
  return redacted;
}
