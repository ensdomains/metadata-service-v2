# Webhook: `POST /webhook`

Notify the metadata service that an ENS name changed so it can drop (and warm)
what it has cached for that name.

The endpoint is **sender-agnostic** — any backend that can produce the signed
`EnsNameEvent` below can call it (an indexer, a reorg handler, a backfill job, a
manual admin script). The wire contract originated with the zigens v2 indexer but
is not tied to it.

> Source of truth: [`src/services/webhook.ts`](../src/services/webhook.ts) (validation +
> cache invalidation) and the `handleWebhook` wrapper in [`src/index.ts`](../src/index.ts)
> (edge purge, D1 persist, image re-warm).

## Endpoint

```
POST https://ens-metadata-v2.ensdomains.workers.dev/webhook
Content-Type: application/json
```

## Required headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Webhook-Timestamp` | current unix time in **seconds** (e.g. `1782217149`) |
| `X-Webhook-Signature` | `sha256=<hex>` — HMAC-SHA256 of `` `${timestamp}.${rawBody}` `` |

## Signature

1. Serialize the JSON body to a string **once** — call it `rawBody`. Sign and send
   the **exact same bytes** (whitespace / key-order changes break verification).
2. Take the current unix timestamp in seconds, `ts`.
3. Build the signing string: `` `${ts}.${rawBody}` `` (timestamp, a literal `.`,
   then the body).
4. `HMAC-SHA256(key, signingString)`, lower-hex encoded, prefixed with `sha256=`.

**The key:** the shared secret is **hex-decoded to raw bytes** before use when it
is valid hex (the normal case — a 64-char hex string → 32 bytes). If it is not
valid hex, its raw UTF-8 bytes are used. So with the standard hex secret your HMAC
key is `hexDecode(secret)`, **not** the ASCII string.

Verification recomputes the HMAC over the exact received bytes and compares in
constant time. The `sha256=` prefix is optional on the value but recommended.

## Body — `EnsNameEvent`

```jsonc
{
  "event_type": "NameRegistered",   // string, required, PascalCase
  "protocol": "v2",                  // "v1" | "v2"  (ENS version, not the chain — see below)
  "name": "anthropic.eth",           // string|null — include it (see note below)
  "namehash": "0x…",                 // string|null
  "block_number": 12345678,          // number
  "tx_hash": "0x…",                  // string
  "log_index": 3,                    // number
  "contract_address": "0x…",         // string
  "data": "{}",                      // string — JSON-encoded extra, opaque to us
  "timestamp": 1782217149            // number, unix seconds
}
```

Validation enforced by the receiver:

- `event_type` — non-empty string (required)
- `timestamp` — number (required)
- `tx_hash` — string (required)
- **`name` OR `namehash` must be present**
- if `name` is present it must be a well-formed ENS name

**Include `name`.** Cache invalidation is name-keyed; an event with only
`namehash` returns `200` but invalidates nothing (a namehash can't be reversed to
a name).

`protocol` is the **ENS version, not the chain**, and it picks the networks that get
re-classified and re-warmed: `v2` events target every network whose indexer speaks
v2 (sepolia today; mainnet joins automatically once it flips), `v1` events target
**all** supported networks. A per-network existence check skips chains where the
name doesn't resolve, so a wrong-chain warm is a no-op.

These `event_type` values additionally flush the expiry-bucketed caches:
`NameRenewed`, `ExpiryUpdated`, `NameBurned`, `LabelUnregistered`, `NameMigrated`.
Any other string is accepted and performs the standard name-keyed invalidation.

## Responses

| Status | Meaning |
|---|---|
| `200` `{status:"success", processed, event, name, timestamp}` | accepted & processed |
| `400` | malformed JSON / missing `event_type` or `timestamp` / invalid `tx_hash` / no name-or-namehash / bad name |
| `401` | missing/invalid signature or timestamp, or timestamp outside the replay window |
| `403` | source IP not in the allowlist (only if one is configured; checked via `CF-Connecting-IP`) |
| `503` | server has no `WEBHOOK_SECRET` configured (fail-closed) |
| `500` | internal error |

Replay window: the timestamp must be within **±120 s** of server time by default
(`WEBHOOK_TOLERANCE_SECS` overrides).

## What it does on accept

For the canonicalized `name`, across **both** networks:

- invalidates internal indexer caches (`domain`, `migrationStatus`, `hierarchy`)
- invalidates batch caches
- invalidates the endpoint metadata cache (`meta:`)
- invalidates image caches (SVG KV + R2 avatar/SVG assets)
- for the expiry-affecting events above, flushes the expiry-bucketed caches
- purges the CF edge cache for every URL shape that could hold the name
  (both networks × `{registry, namewrapper}` × `{image, rasterize}`)
- re-classifies the name on each target network (chosen by `protocol`, see above),
  records the result in D1 and proactively re-warms the default image there

## Example — Node (built-ins only)

```js
import crypto from 'node:crypto';

const URL = 'https://ens-metadata-v2.ensdomains.workers.dev/webhook';
const SECRET = process.env.WEBHOOK_SECRET; // the 64-char hex secret

const ts = Math.floor(Date.now() / 1000);
const event = {
  event_type: 'NameRenewed',
  protocol: 'v2',
  name: 'anthropic.eth',
  namehash: null,
  block_number: 0,
  tx_hash: '0x',
  log_index: 0,
  contract_address: '0x',
  data: '{}',
  timestamp: ts,
};

const rawBody = JSON.stringify(event); // sign these exact bytes

// key = hex-decoded secret (fallback to utf-8 if not hex)
const key = /^[0-9a-fA-F]+$/.test(SECRET) && SECRET.length % 2 === 0
  ? Buffer.from(SECRET, 'hex')
  : Buffer.from(SECRET, 'utf8');

const sig = crypto.createHmac('sha256', key)
  .update(`${ts}.${rawBody}`)
  .digest('hex');

const res = await fetch(URL, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-webhook-timestamp': String(ts),
    'x-webhook-signature': `sha256=${sig}`,
  },
  body: rawBody,
});
console.log(res.status, await res.text());
```

## Example — curl

```bash
SECRET="<hex-secret>"
TS=$(date +%s)
BODY='{"event_type":"NameRenewed","protocol":"v2","name":"anthropic.eth","namehash":null,"block_number":0,"tx_hash":"0x","log_index":0,"contract_address":"0x","data":"{}","timestamp":'"$TS"'}'
SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"$SECRET" | sed 's/^.* //')

curl -X POST https://ens-metadata-v2.ensdomains.workers.dev/webhook \
  -H "content-type: application/json" \
  -H "x-webhook-timestamp: $TS" \
  -H "x-webhook-signature: sha256=$SIG" \
  -d "$BODY"
```

`-macopt hexkey:` is the hex-decode-the-secret step.

## Checklist

- Sign the **exact bytes** you send; serialize once.
- Timestamp in **seconds**, within **±120 s** of server time.
- HMAC **key is the hex-decoded secret**, not the ASCII string.
- Include **`name`**, or nothing is invalidated.
- `protocol` is the **ENS version, not the chain** (`v2` → networks whose indexer speaks v2, `v1` → all networks).
- Server is **fail-closed**: no `WEBHOOK_SECRET` in prod → every call gets `503`.
