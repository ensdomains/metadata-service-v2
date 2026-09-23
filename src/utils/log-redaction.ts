// Keep secret values out of Workers Logs.
//
// MAINNET_RPC_URL and SEPOLIA_RPC_URL are secrets, and RPC providers put the API
// key in the URL (Alchemy /v2/<key>, Infura /v3/<id>, QuickNode tokens). viem
// copies the full request URL into its transport errors ("URL: https://…"), and
// those errors are logged from many places: the RPC rotation in BlockchainService,
// AvatarService's resolution warnings, the fallback tiers, and the UpstreamError
// message and cause chain built from them. A per-call-site fix would be easy to
// miss, so instead the console methods are wrapped once and every registered
// secret, plus the path and query of each secret URL, is replaced before a line
// is written. Only exact secret values are redacted; public URLs stay readable.

const REDACTED = '[redacted]';
// Fragments shorter than this (e.g. a bare "/" path) carry no key material and
// would only mangle unrelated log text.
const MIN_FRAGMENT_LENGTH = 8;
const MAX_CAUSE_DEPTH = 5;
const CONSOLE_METHODS = ['debug', 'info', 'log', 'warn', 'error'] as const;
const WRAPPED = Symbol.for('ens-metadata.console-redaction');

const secrets = new Set<string>();
let ordered: string[] = [];

/** Register secret values (typically env bindings) to be redacted from logs. */
export function registerLogSecrets(values: ReadonlyArray<string | undefined>): void {
  let changed = false;
  const add = (fragment: string) => {
    if (fragment.length >= MIN_FRAGMENT_LENGTH && !secrets.has(fragment)) {
      secrets.add(fragment);
      changed = true;
    }
  };
  for (const value of values) {
    if (!value) continue;
    add(value);
    try {
      const url = new URL(value);
      add(`${url.pathname}${url.search}`);
      if (url.username) add(url.username);
      if (url.password) add(url.password);
    } catch {
      // Not a URL: the value itself is the secret.
    }
  }
  // Longest first, so a full URL is replaced before its own path fragment.
  if (changed) ordered = [...secrets].sort((a, b) => b.length - a.length);
}

export function redactText(text: string): string {
  let out = text;
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

// A fresh Error carrying only the redacted name, message, stack and cause. Extra
// properties (viem errors keep `url`, `details`, `metaMessages`, request body)
// are dropped rather than copied, so none of them can carry the secret.
function redactError(error: Error, depth: number): Error {
  const copy = new Error(redactText(error.message));
  copy.name = error.name;
  copy.stack = error.stack === undefined ? undefined : redactText(error.stack);
  const { cause } = error as { cause?: unknown };
  if (cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    (copy as { cause?: unknown }).cause = redactValue(cause, depth + 1);
  }
  return copy;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (ordered.length === 0) return value;
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) return redactError(value, depth);
  if (value !== null && typeof value === 'object') {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      return value;
    }
    if (json !== undefined && ordered.some((s) => json!.includes(s))) return redactText(json);
  }
  return value;
}

type ConsoleLike = Pick<Console, (typeof CONSOLE_METHODS)[number]>;

/** Wrap a console's methods so every argument is redacted. Idempotent. */
export function wrapConsole(target: ConsoleLike): void {
  const marked = target as ConsoleLike & { [WRAPPED]?: boolean };
  if (marked[WRAPPED]) return;
  marked[WRAPPED] = true;
  for (const method of CONSOLE_METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(...args.map((a) => redactValue(a)));
  }
}

/** Wrap the global console. */
export function installConsoleRedaction(): void {
  wrapConsole(console);
}
