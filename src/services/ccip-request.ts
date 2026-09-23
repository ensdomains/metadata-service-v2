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
// and gateway requests (request-budget.ts), since a batch-gateway lookup fans
// out to as many requests as the contract asks for. ccipBudgetedHttp, the
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
import { fetchMediaUrl, readBodyCapped } from './media-fetch';
import { takeCcipBytes, takeCcipRequest, takeOffchainLookup } from './request-budget';

export const CCIP_TIMEOUT_MS = 8_000;
// Real gateway responses (signed resolver results, proofs) are kilobytes.
export const MAX_CCIP_RESPONSE_BYTES = 1024 * 1024;

export async function guardedCcipRequest({ data, sender, urls }: CcipRequestParameters): Promise<Hex> {
  let error: Error = new Error('An unknown error occurred.');
  for (const url of urls) {
    // Once this request's allowance is spent, do not send the request at all.
    if (!takeCcipRequest()) throw new Error('CCIP allowance for this request is spent');
    const method = url.includes('{data}') ? 'GET' : 'POST';
    const body = method === 'POST' ? { data, sender } : undefined;
    try {
      const response = await fetchMediaUrl(url.replace('{sender}', sender.toLowerCase()).replace('{data}', data), {
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        signal: AbortSignal.timeout(CCIP_TIMEOUT_MS),
      });
      const raw = await readBodyCapped(response, MAX_CCIP_RESPONSE_BYTES, takeCcipBytes);
      if (!raw) throw new Error('gateway response over the size cap or this request\'s CCIP allowance');
      const text = new TextDecoder().decode(raw);
      const result: unknown = response.headers.get('Content-Type')?.startsWith('application/json')
        ? (JSON.parse(text) as { data?: unknown }).data
        : text;
      if (!response.ok) {
        error = new HttpRequestError({ body, details: response.statusText, status: response.status, url });
        continue;
      }
      if (typeof result !== 'string' || !isHex(result)) {
        error = new Error(`Offchain gateway response is malformed. URL: ${url}`);
        continue;
      }
      return result;
    } catch (err) {
      error = new HttpRequestError({ body, details: (err as Error).message, url });
    }
  }
  throw error;
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
