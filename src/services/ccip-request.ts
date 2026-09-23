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
// per gateway, a bounded response, and a per-request byte budget shared by
// every gateway response (request-budget.ts), since a batch-gateway lookup
// fans out to as many requests as the contract asks for.
import { HttpRequestError, isHex, type CcipRequestParameters, type Hex } from 'viem';
import { fetchMediaUrl, readBodyCapped } from './media-fetch';
import { ccipAllowanceExhausted, takeCcipBytes } from './request-budget';

export const CCIP_TIMEOUT_MS = 8_000;
// Real gateway responses (signed resolver results, proofs) are kilobytes.
export const MAX_CCIP_RESPONSE_BYTES = 1024 * 1024;

export async function guardedCcipRequest({ data, sender, urls }: CcipRequestParameters): Promise<Hex> {
  let error: Error = new Error('An unknown error occurred.');
  for (const url of urls) {
    // Once this request's allowance is spent, every further response would be
    // refused at its first chunk: do not send the request at all.
    if (ccipAllowanceExhausted()) throw new Error('CCIP allowance for this request is spent');
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
