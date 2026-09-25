// Guarded CCIP-read (EIP-3668) gateway requests.
//
// When a resolver or contract reverts with OffchainLookup, viem fetches the
// gateway URLs listed in the revert, which whoever deployed that contract
// chooses. viem's default ccipRequest uses a bare fetch(): redirects are
// followed anywhere, the body is read with no size limit and there is no
// timeout. Any name can reach it through its resolver, and an avatar record
// can reach it through an NFT contract whose tokenURI() reverts. This is the
// same request with every URL and redirect hop checked by fetchMediaUrl
// (private hosts and this service's own hostnames are refused), one timeout
// per gateway, a bounded response, and a per-request budget of gateway bytes
// and gateway fetches (request-budget.ts; every redirect hop is a fetch), since
// a batch-gateway lookup fans out to as many requests as the contract asks for. ccipBudgetedHttp, the
// transport of every client that reads contracts, counts OffchainLookup turns
// against the same budget, since viem follows recursive lookups with no depth
// limit.
import {
  BaseError,
  HttpRequestError,
  http,
  isHex,
  offchainLookupSignature,
  type CcipRequestParameters,
  type Hex,
  type HttpTransport,
  type HttpTransportConfig,
} from 'viem';
import { assertFetchableMediaUrl, fetchMediaUrl, readBodyCapped } from './media-fetch';
import { takeCcipBytes, takeCcipRequest, takeOffchainLookup } from './request-budget';

export const CCIP_TIMEOUT_MS = 8_000;
// Real gateway responses (signed resolver results, proofs) are kilobytes.
export const MAX_CCIP_RESPONSE_BYTES = 1024 * 1024;

class CcipAllowanceSpentError extends Error {
  constructor() {
    super('CCIP allowance for this request is spent');
    this.name = 'CcipAllowanceSpentError';
  }
}

/**
 * A failed gateway request: the gateway's status, or none when it could not be
 * reached or its response was unusable (malformed, a redirect the guard
 * refuses). It keeps viem's HttpRequestError class and name (viem's local batch
 * gateway encodes it as HttpError(status) for the Universal Resolver), and the
 * subclass tells an avatar lookup a gateway's answer apart from an error of the
 * RPC endpoint itself.
 */
export class CcipGatewayError extends HttpRequestError {}

/**
 * Whether a gateway status is the gateway's final answer for the request (the
 * name has no such record) rather than a failure. EIP-3668 makes a 4xx final,
 * except 401 and 403 (a WAF blocking Workers egress or an expired gateway key:
 * the gateway's infrastructure, not the name), 408 and 429. A 3xx and every 5xx
 * (501 included) are failures.
 */
export function isFinalGatewayStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 408 && status !== 429;
}

// The status reported for a gateway URL that the guard's rules (media-fetch.ts)
// refuse. The URL is checked before anything is fetched and would be refused
// for a later request too, so it is reported the way a gateway rejecting the
// request is: a final 4xx answer rather than an outage. A redirect hop the
// guard refuses comes from a gateway that was fetched, so it is a gateway
// failure instead.
export const REFUSED_GATEWAY_STATUS = 400;

// Charged before every gateway fetch, redirect hops included: each one is a
// Worker subrequest.
function chargeGatewayFetch(): void {
  if (!takeCcipRequest()) throw new CcipAllowanceSpentError();
}

export async function guardedCcipRequest({ data, sender, urls }: CcipRequestParameters): Promise<Hex> {
  let answer: Error | undefined;
  let failure: Error | undefined;
  let refused: Error | undefined;
  for (const url of urls) {
    const method = url.includes('{data}') ? 'GET' : 'POST';
    const body = method === 'POST' ? { data, sender } : undefined;
    const target = url.replace('{sender}', sender.toLowerCase()).replace('{data}', data);
    try {
      assertFetchableMediaUrl(new URL(target));
    } catch (err) {
      refused ??= new CcipGatewayError({ body, details: (err as Error).message, status: REFUSED_GATEWAY_STATUS, url });
      continue;
    }
    try {
      const response = await fetchMediaUrl(target, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        signal: AbortSignal.timeout(CCIP_TIMEOUT_MS),
      }, undefined, chargeGatewayFetch);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const error = new CcipGatewayError({ body, details: response.statusText, status: response.status, url });
        if (isFinalGatewayStatus(response.status)) answer = error;
        else failure = error;
        continue;
      }
      const raw = await readBodyCapped(response, MAX_CCIP_RESPONSE_BYTES, takeCcipBytes);
      if (!raw) throw new Error('gateway response over the size cap or this request\'s CCIP allowance');
      const text = new TextDecoder().decode(raw);
      const result: unknown = response.headers.get('Content-Type')?.startsWith('application/json')
        ? (JSON.parse(text) as { data?: unknown }).data
        : text;
      if (typeof result !== 'string' || !isHex(result)) {
        failure = new CcipGatewayError({ body, details: 'malformed response', url });
        continue;
      }
      return result;
    } catch (err) {
      // Once this request's allowance is spent, do not try the other gateways.
      if (err instanceof CcipAllowanceSpentError) throw err;
      // Unreachable, or a redirect hop the guard refuses (or one too many).
      failure = new CcipGatewayError({ body, details: (err as Error).message, url });
    }
  }
  // A gateway's final answer outranks a gateway that failed (EIP-3668: a 4xx is
  // final), which outranks a URL the guard refused.
  throw answer ?? failure ?? refused ?? new Error('An unknown error occurred.');
}

// The revert data viem inspects to decide whether to follow a lookup (its
// internal getRevertErrorData).
function isOffchainLookupRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const inner = err.walk() as { data?: unknown } | null;
  const data = typeof inner?.data === 'object' ? (inner.data as { data?: unknown } | null)?.data : inner?.data;
  return typeof data === 'string' && data.slice(0, 10) === offchainLookupSignature;
}

/**
 * viem's http transport, charging every eth_call that reverts with
 * OffchainLookup to this request's budget. Each such revert is one turn viem is
 * about to follow, whether or not the turn reaches guardedCcipRequest (a local
 * batch gateway lookup with no queries does not). Once the budget is spent the
 * revert is replaced by an error viem does not follow, which ends the lookup;
 * calls that do not revert with OffchainLookup are untouched.
 */
export function ccipBudgetedHttp(url?: string, config?: HttpTransportConfig): HttpTransport {
  const transport = http(url, config);
  return ((params) => {
    const inner = transport(params);
    const request: typeof inner.request = async (args, options) => {
      try {
        return await inner.request(args, options);
      } catch (err) {
        if (args.method === 'eth_call' && isOffchainLookupRevert(err) && !takeOffchainLookup()) {
          throw new BaseError('CCIP-Read lookups for this request are spent');
        }
        throw err;
      }
    };
    return { ...inner, request };
  }) as HttpTransport;
}
