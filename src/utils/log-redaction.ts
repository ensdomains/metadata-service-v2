// Keep secret values out of Workers Logs.
//
// MAINNET_RPC_URL and SEPOLIA_RPC_URL are secrets, and RPC providers put the API
// key in the URL (Alchemy /v2/<key>, Infura /v3/<id>, QuickNode tokens). viem
// copies the full request URL into its transport errors ("URL: https://…"), and
// those errors are logged from many places: the RPC rotation in BlockchainService,
// AvatarService's resolution warnings, the fallback tiers, and the UpstreamError
// message and cause chain built from them. A per-call-site fix would be easy to
// miss, so the console methods are wrapped once.
//
// Once any secret is registered, the wrapped console never hands the runtime a
// structured value: every call is formatted to text first (node:util, the same
// formatter the console uses), every registered secret and the path and query
// of each secret URL are replaced in that text, and only the resulting string
// is logged. Whatever an argument holds (nested errors, AggregateError.errors,
// Headers, symbol keys, getters, custom toString), it either appears in that
// text and is redacted, or it is not logged at all. Public URLs stay readable.
import { formatWithOptions, inspect } from 'node:util';

const REDACTED = '[redacted]';
// Fragments shorter than this (e.g. a bare "/" path) carry no key material and
// would only mangle unrelated log text.
const MIN_FRAGMENT_LENGTH = 8;
// A single path segment or query value this long is treated as a key on its
// own, since providers echo the bare key too (auth headers, "invalid key" errors).
const MIN_KEY_SEGMENT_LENGTH = 16;
// maxStringLength: node:util otherwise cuts nested strings at 10000 chars
// BEFORE redaction, which could leave the start of a key that no registered
// fragment matches.
const FORMAT_OPTIONS = { depth: 6, breakLength: Infinity, maxStringLength: Infinity };
const DROPPED = '[log line dropped: could not be formatted for redaction]';

const WRAPPED = Symbol.for('ens-metadata.console-redaction');

// One registry per isolate, shared by every instance of this module (a test
// runner can load the module twice; the installed wrapper must see secrets
// registered through either copy).
const REGISTRY_KEY = Symbol.for('ens-metadata.log-secrets');
interface Registry {
  secrets: Set<string>;
  ordered: string[];
}
const globalSlots = globalThis as unknown as Record<symbol, Registry | undefined>;
const registry: Registry = globalSlots[REGISTRY_KEY] ?? (globalSlots[REGISTRY_KEY] = { secrets: new Set<string>(), ordered: [] });

/** Register secret values (typically env bindings) to be redacted from logs. */
export function registerLogSecrets(values: ReadonlyArray<string | undefined>): void {
  let changed = false;
  const add = (fragment: string) => {
    if (fragment.length >= MIN_FRAGMENT_LENGTH && !registry.secrets.has(fragment)) {
      registry.secrets.add(fragment);
      changed = true;
    }
  };
  for (const value of values) {
    if (!value) continue;
    add(value);
    try {
      const url = new URL(value);
      add(`${url.pathname}${url.search}`);
      // inspect(URL) prints pathname, search and searchParams separately.
      add(url.pathname);
      add(url.search);
      if (url.username) add(url.username);
      if (url.password) add(url.password);
      // Query values in both their raw (percent-encoded) and decoded forms.
      const rawQueryValues = url.search.slice(1).split('&').map((pair) => pair.slice(pair.indexOf('=') + 1));
      for (const piece of [...rawQueryValues, ...url.searchParams.values()]) add(piece);
      for (const piece of url.pathname.split('/')) if (piece.length >= MIN_KEY_SEGMENT_LENGTH) add(piece);
    } catch {
      // Not a URL: the value itself is the secret.
    }
  }
  // Longest first, so a full URL is replaced before its own path fragment.
  if (changed) registry.ordered = [...registry.secrets].sort((a, b) => b.length - a.length);
}

export function redactText(text: string): string {
  let out = text;
  for (const secret of registry.ordered) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Format console arguments to the text the console would print, then redact it. */
export function formatRedacted(args: readonly unknown[]): string {
  try {
    return redactText(formatWithOptions(FORMAT_OPTIONS, ...args));
  } catch {
    return DROPPED;
  }
}

const TEXT_METHODS = ['debug', 'info', 'log', 'warn', 'error', 'trace', 'group', 'groupCollapsed'] as const;
type ConsoleFn = (...args: unknown[]) => void;
type ConsoleLike = Partial<Record<string, unknown>>;

/**
 * Wrap a console so that, once secrets are registered, it only ever receives
 * redacted strings. Idempotent; never throws into the caller.
 */
export function wrapConsole(target: ConsoleLike | Console): void {
  const c = target as ConsoleLike & { [WRAPPED]?: boolean };
  if (c[WRAPPED]) return;
  c[WRAPPED] = true;
  const active = () => registry.ordered.length > 0;

  for (const method of TEXT_METHODS) {
    const original = c[method];
    if (typeof original !== 'function') continue;
    const bound = (original as ConsoleFn).bind(target);
    c[method] = (...args: unknown[]) => (active() ? bound(formatRedacted(args)) : bound(...args));
  }

  if (typeof c.assert === 'function') {
    const bound = (c.assert as ConsoleFn).bind(target);
    // Keep the condition itself: only the message is formatted.
    c.assert = (condition?: unknown, ...rest: unknown[]) =>
      active() ? bound(Boolean(condition), formatRedacted(rest)) : bound(condition, ...rest);
  }

  for (const method of ['dir', 'dirxml', 'table'] as const) {
    const original = c[method];
    if (typeof original !== 'function') continue;
    const bound = (original as ConsoleFn).bind(target);
    // These print structure; hand them the redacted text instead.
    c[method] = (...args: unknown[]) => {
      if (!active()) return bound(...args);
      let text: string;
      try {
        text = redactText(args.length ? inspect(args[0], FORMAT_OPTIONS) : '');
      } catch {
        text = DROPPED;
      }
      bound(text);
    };
  }
}

/** Wrap the global console. */
export function installConsoleRedaction(): void {
  wrapConsole(console);
}
