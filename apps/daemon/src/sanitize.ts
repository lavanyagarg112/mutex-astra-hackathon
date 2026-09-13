import { redactSensitive } from "@relaycode/shared";

const INLINE_SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|bearer\s+[A-Za-z0-9._~+/=-]+)\b/gi;
const URL_CREDENTIALS = /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;

export function sanitizeText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(redactSensitive(value));
  return text.replace(URL_CREDENTIALS, "$1[REDACTED]@").replace(INLINE_SECRET, "[REDACTED]");
}

/** Environment used by an LLM-controlled subprocess. Credentials stay outside its reach. */
export function agentChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const blocked = /(?:TOKEN|SECRET|PASSWORD|COOKIE|AUTHORIZATION|API[_-]?KEY|AWS_|AZURE_|GITHUB_|GH_TOKEN)/i;
  return Object.fromEntries(Object.entries(source).filter(([key]) => !blocked.test(key)));
}
