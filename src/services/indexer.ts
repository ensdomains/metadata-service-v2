import { canonicalTokenId, labelhash, namehash } from "../utils/ens";
import { UpstreamError } from "./errors";
import { timeLeftForAttempt } from "./request-budget";

// How long an isRegistry answer is reused. Only whether the address is a
// registry is kept, never its name (see getDomainByTokenId): a registry stays
// one, so a hit is kept longer; a miss is kept briefly, so a registry deployed
// since is recognized soon after the indexer sees it.
export const REGISTRY_KNOWN_TTL_MS = 60 * 60 * 1000;
export const REGISTRY_UNKNOWN_TTL_MS = 5 * 60 * 1000;
/** Most addresses remembered per indexer; the least recently used is dropped beyond it. */
export const REGISTRY_CACHE_MAX_ENTRIES = 10_000;

/**
 * Most labels read to name a v2 registry token. bigname has no token id
 * filter, so a token is found by reading the registry's labels; a registry
 * with more labels than this (the ETHRegistry) is not scanned, and its native
 * token ids are a miss.
 */
export const MAX_REGISTRY_LABELS_SCANNED = 1_000;

/** Largest page bigname serves. */
const PAGE_SIZE = 200;
/** Most inputs per POST /v1/lookup. */
const LOOKUP_BATCH_SIZE = 1_000;
/** Attempts per request: a `stale` answer or a transport failure is retried. */
const MAX_ATTEMPTS = 3;
const STALE_BACKOFF_MS = 150;
/** At or above this, bigname's expiry means "never expires" (i64::MAX or 2^64 - 1). */
const NO_EXPIRY_SECONDS = 9223372036854775807n;

// ---- bigname wire types (only the fields read here) ----

interface ContractRef {
  chain_id: number;
  address: string;
}

/** A name row: name detail, a lookup record, or a registry label. */
interface BignameName {
  name?: string | null;
  namehash?: string;
  labelhash?: string;
  owner?: string | null;
  status?: 'active' | 'expired' | 'released' | 'unregistered';
  authority?: 'ens_v0' | 'ens_v1' | 'ens_v2';
  expires_at?: string | null;
  created_at?: string | null;
  registered_at?: string | null;
  migrated_at?: string | null;
  token_id?: string | null;
  resolver?: ContractRef | null;
  ens_v1?: { resolver?: ContractRef | null } | null;
  lapsed_registration?: { released_at?: string | null } | null;
}

interface LookupResult {
  status: string;
  record?: BignameName | null;
}

interface RegistryOverview {
  address: string;
  name?: { name?: string } | null;
  counts?: { labels?: number };
}

interface Page {
  next_cursor?: string | null;
}

interface Envelope<T> {
  data: T;
  page?: Page;
}

// Response types
export interface IndexerDomain {
  id: string;
  name: string;
  labelName: string;
  labelhash: string;
  parentId?: string;
  ownerId?: string;
  resolverId?: string;
  registrantId?: string;
  owner?: {
    id: string;
  };
  resolver?: {
    address: string;
  };
  registrant?: {
    id: string;
  };
  parent?: {
    id?: string;
    name?: string;
  };
  expiryDate?: string;
  createdAt?: string;
  ttl?: number;
  /** True when bigname reports an ENSv1→ENSv2 migration (`migrated_at`).
   *  Absent when it reports none, which is not proof the name was born on v2:
   *  see classifyV2IndexerRecord. */
  isMigrated?: boolean;
  tokenId?: string;
  /** Registry generation that owns the name: "v1" (bigname `ens_v0`/`ens_v1`)
   *  or "v2" (`ens_v2`). bigname serves both, so classification must not
   *  equate presence with being on v2 (see utils/migration.ts). */
  protocol?: string;
  /** Set ONLY by the blockchain fallback tier (fallback.ts): the on-chain
   *  classification of the record (`unmigrated` | `migrated`; never `native`). */
  chainMigrationStatus?: string;
}

export interface IndexerMigrationStatus {
  name: string;
  /** Absent when unknown, as on IndexerDomain: never read as born on v2. */
  isMigrated?: boolean;
  ownerId?: string;
  resolverId?: string;
  parentId?: string;
  owner?: { id: string };
  resolver?: { address: string };
  expiryDate?: string;
  /** Registry generation ("v1" | "v2"); see IndexerDomain.protocol. */
  protocol?: string;
  /** Set ONLY by the blockchain fallback tier — see IndexerDomain.chainMigrationStatus. */
  chainMigrationStatus?: string;
}

export interface IndexerHierarchyItem {
  name: string;
  ownerId?: string;
  resolverId?: string;
  parentId?: string;
  owner?: { id: string };
  resolver?: { address: string };
  parent?: IndexerHierarchyItem;
}

/** A bigname failure worth another attempt: `stale` (409) and server-side errors. */
class RetryableError extends Error {}

const parentOf = (name: string): string => name.split('.').slice(1).join('.');

/** A registry overview, or UpstreamError for a reply without its address (not an answer). */
function registryOverview(answer: Envelope<RegistryOverview> | null, registry: string): RegistryOverview | null {
  if (answer && typeof (answer.data as { address?: unknown }).address !== 'string') {
    throw new UpstreamError(`malformed bigname registry overview for ${registry}`);
  }
  return answer?.data ?? null;
}

/** Unix seconds, or undefined for an absent expiry or one that never comes. */
function finiteSeconds(value: string | null | undefined): string | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return BigInt(value) >= NO_EXPIRY_SECONDS ? undefined : value;
}

/**
 * The service's domain shape from a bigname name row. Null for a name with no
 * registration, now or before (`unregistered`). A released name keeps its
 * release time as the expiry, so it is served as expired, not as unknown.
 */
function toDomain(row: BignameName): IndexerDomain | null {
  if (!row.name || row.status === 'unregistered') return null;
  const name = row.name;
  const label = name.split('.')[0];
  const parentName = parentOf(name);
  const owner = row.owner ?? undefined;
  // The ENSv1 registry pointer when the row has one (null means none set);
  // otherwise the resolver the name resolves through.
  const resolver = row.ens_v1 && 'resolver' in row.ens_v1 ? row.ens_v1.resolver : row.resolver;
  const expiry = row.status === 'released'
    ? (row.lapsed_registration?.released_at ?? row.expires_at)
    : row.expires_at;
  const isEth2ld = parentName === 'eth';
  const protocol = row.authority === 'ens_v2' ? 'v2' : row.authority ? 'v1' : undefined;
  return {
    id: row.namehash ?? namehash(name),
    name,
    labelName: label,
    labelhash: row.labelhash ?? labelhash(label),
    parentId: parentName ? namehash(parentName) : undefined,
    parent: parentName ? { id: namehash(parentName), name: parentName } : undefined,
    ownerId: owner,
    owner: owner ? { id: owner } : undefined,
    // An ENSv1 .eth name's holder is its registrar registrant.
    registrantId: protocol === 'v1' && isEth2ld ? owner : undefined,
    registrant: protocol === 'v1' && isEth2ld && owner ? { id: owner } : undefined,
    resolverId: resolver?.address,
    resolver: resolver ? { address: resolver.address } : undefined,
    expiryDate: finiteSeconds(expiry),
    createdAt: row.created_at ?? row.registered_at ?? undefined,
    isMigrated: row.migrated_at ? true : undefined,
    tokenId: row.token_id ?? undefined,
    protocol,
  };
}

function toHierarchyItem(domain: IndexerDomain, parent?: IndexerHierarchyItem): IndexerHierarchyItem {
  return {
    name: domain.name,
    ownerId: domain.ownerId,
    resolverId: domain.resolverId,
    parentId: domain.parentId,
    owner: domain.owner,
    resolver: domain.resolver,
    parent,
  };
}

/**
 * bigname REST client for one chain. bigname indexes ENSv1 and ENSv2 names in
 * one index, so a single client covers both protocols.
 */
export class IndexerService {
  private endpoint: string;
  private chainId: number;
  private timeout: number;

  constructor(config: { endpoint: string; chainId: number; timeout?: number }) {
    // A missing URL fails each request (the chain tier then answers), not the constructor.
    this.endpoint = (config.endpoint ?? '').replace(/\/+$/, '');
    this.chainId = config.chainId;
    this.timeout = config.timeout || 2000;
    console.log(`[indexer] initialized with endpoint: ${this.endpoint}, chain: ${this.chainId}, timeout: ${this.timeout}ms`);
  }

  // One attempt: the parsed envelope, null for a 404 `not_found`. `stale` and
  // server-side failures throw RetryableError; any other error answer (a bad
  // input, `conflict`, `unsupported`) throws UpstreamError, not retried.
  private async attempt<T>(path: string, init: RequestInit, signal: AbortSignal): Promise<Envelope<T> | null> {
    const response = await fetch(`${this.endpoint}${path}`, {
      ...init,
      headers: { 'User-Agent': 'ENS-Metadata-V2/2.0.0', ...(init.headers ?? {}) },
      signal,
    });
    const body = await response.json().catch(() => undefined) as
      | { data?: T; page?: Page; error?: { code?: string; message?: string } }
      | undefined;
    const code = body?.error?.code;
    if (response.status === 404 && code === 'not_found') return null;
    // A 200 without a data object (a proxy or maintenance page, {"data":null})
    // is not an answer, so it fails the attempt rather than read as a miss.
    if (response.ok && body?.data !== null && typeof body?.data === 'object') {
      return { data: body.data as T, page: body.page };
    }
    const message = `bigname ${response.status}${code ? ` ${code}` : ''} for ${path}`;
    if (code === 'stale' || response.status >= 500 || response.status === 408 || response.status === 429) {
      throw new RetryableError(message);
    }
    if (response.ok) throw new RetryableError(`malformed bigname response for ${path}: no data field`);
    throw new UpstreamError(message);
  }

  // A bigname request. `stale`, timeouts and transport failures are retried
  // (MAX_ATTEMPTS in all), then end in UpstreamError. A 404 `not_found` is
  // null: a clean miss, which the fallback layer does not count as a failure.
  //
  // Inside a request, each attempt's timeout is cut to what is left of the
  // request's deadline (the signal aborts the fetch itself), and no attempt
  // starts once it is (nearly) spent. An attempt that fails with the deadline
  // spent ends in RequestDeadlineError: running out of the request's time is
  // not the indexer's failure and must not trip the circuit-breaker.
  private async request<T>(path: string, init: RequestInit = {}): Promise<Envelope<T> | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const timeLeft = timeLeftForAttempt('bigname request', lastError);
      try {
        return await this.attempt<T>(path, init, AbortSignal.timeout(Math.min(this.timeout, timeLeft)));
      } catch (error) {
        timeLeftForAttempt('bigname answered', error);
        if (error instanceof UpstreamError) throw error;
        lastError = error;
        console.warn(`[indexer] bigname request failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}):`, error);
        if (error instanceof RetryableError && attempt < MAX_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, STALE_BACKOFF_MS * (attempt + 1)));
        }
      }
    }
    throw new UpstreamError(`bigname request failed: ${lastError}`, { cause: lastError });
  }

  private async lookup(names: readonly string[]): Promise<LookupResult[]> {
    const results: LookupResult[] = [];
    for (let i = 0; i < names.length; i += LOOKUP_BATCH_SIZE) {
      const inputs = names.slice(i, i + LOOKUP_BATCH_SIZE).map((name) => ({ name }));
      const answer = await this.request<LookupResult[]>('/v1/lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ namespace: 'ens', profile: 'detail', inputs }),
      });
      if (!answer || !Array.isArray(answer.data) || answer.data.length !== inputs.length) {
        throw new UpstreamError('malformed bigname lookup response');
      }
      results.push(...answer.data);
    }
    return results;
  }

  // Get single domain data
  async getDomain(name: string): Promise<{ domain: IndexerDomain | null }> {
    const answer = await this.request<BignameName>(`/v1/names/${encodeURIComponent(name.toLowerCase())}`);
    if (!answer) return { domain: null };
    // A name detail without its name is not an answer, so never a miss.
    if (typeof answer.data.name !== 'string') throw new UpstreamError(`malformed bigname name detail for ${name}`);
    return { domain: toDomain(answer.data) };
  }

  /**
   * The .eth name with this labelhash (a BaseRegistrar token id). bigname
   * reads a label spelled as its bracketed labelhash; a name whose label it
   * does not know comes back bracketed, and is a miss.
   */
  async getEthDomainByLabelhash(hash: string): Promise<{ domain: IndexerDomain | null }> {
    const label = hash.toLowerCase().replace(/^0x/, '');
    const { domain } = await this.getDomain(`[${label}].eth`);
    return { domain: domain && !domain.name.includes('[') ? domain : null };
  }

  /**
   * The domain the v2 registry at `registry` holds under a token id (a
   * labelhash whose low 32 bits are the token version), named by the
   * registry's canonical name: `<label>.<registry name>`. Several names can
   * point their subregistry at one registry (aliases); the registry's own name
   * is where it hangs now, and is read with each lookup, never cached, since a
   * registry moved under another parent is renamed.
   *
   * bigname has no token id filter, so the registry's labels are read and
   * matched on the version-free id, which also matches ids from before a
   * re-registration bumped the version. A registry bigname does not know, one
   * with no name, or one with more than MAX_REGISTRY_LABELS_SCANNED labels is
   * a miss, as is a label that is unregistered or released.
   */
  async getDomainByTokenId(tokenId: `0x${string}`, registry: string): Promise<{ domain: IndexerDomain | null }> {
    const registryPath = `/v1/registries/${this.chainId}/${registry.toLowerCase()}`;
    const overview = registryOverview(await this.request<RegistryOverview>(registryPath), registry);
    const registryName = overview?.name?.name;
    if (!overview || typeof registryName !== 'string') return { domain: null };
    const labelCount = overview.counts?.labels ?? Number.POSITIVE_INFINITY;
    if (labelCount > MAX_REGISTRY_LABELS_SCANNED) {
      console.warn(`[indexer] registry ${registry} has ${labelCount} labels, not scanned for token ${tokenId}`);
      return { domain: null };
    }

    const wanted = canonicalTokenId(tokenId);
    let cursor: string | null | undefined;
    const pages = Math.ceil(MAX_REGISTRY_LABELS_SCANNED / PAGE_SIZE);
    for (let page = 0; page < pages; page++) {
      const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });
      if (cursor) query.set('cursor', cursor);
      const answer = await this.request<BignameName[]>(`${registryPath}/labels?${query}`);
      if (!answer) return { domain: null };
      if (!Array.isArray(answer.data)) throw new UpstreamError(`malformed bigname registry labels for ${registry}`);
      const row = answer.data.find((label) => label.labelhash && canonicalTokenId(label.labelhash) === wanted);
      if (row) {
        if (row.status === 'unregistered' || row.status === 'released' || !row.name) return { domain: null };
        const label = row.name.split('.')[0];
        if (label.startsWith('[')) return { domain: null };
        const name = registryName ? `${label}.${registryName}` : label;
        return { domain: toDomain({ ...row, name, namehash: undefined }) };
      }
      cursor = answer.page?.next_cursor;
      if (!cursor) break;
    }
    return { domain: null };
  }

  // isRegistry answers, per lowercase address: whether it is a registry, and
  // until when to reuse that. Map order is recency (re-inserted on each hit).
  private registryCache = new Map<string, { known: boolean; until: number }>();

  /**
   * Whether bigname knows a v2 registry at `address`. Answers are cached per
   * isolate (REGISTRY_KNOWN_TTL_MS for a registry, REGISTRY_UNKNOWN_TTL_MS for
   * none, at most REGISTRY_CACHE_MAX_ENTRIES addresses), so a request for a
   * random address costs one indexer request per isolate in that time rather
   * than one each. Only that is cached: the registry's name, which changes
   * when it moves, is read with each token lookup. An outage throws
   * UpstreamError and is not cached.
   */
  async isRegistry(address: string): Promise<boolean> {
    const key = address.toLowerCase();
    const cached = this.registryCache.get(key);
    if (cached) {
      this.registryCache.delete(key);
      if (Date.now() < cached.until) {
        this.registryCache.set(key, cached);
        return cached.known;
      }
    }

    const known = registryOverview(await this.request<RegistryOverview>(`/v1/registries/${this.chainId}/${key}`), key) !== null;

    const ttl = known ? REGISTRY_KNOWN_TTL_MS : REGISTRY_UNKNOWN_TTL_MS;
    this.registryCache.set(key, { known, until: Date.now() + ttl });
    if (this.registryCache.size > REGISTRY_CACHE_MAX_ENTRIES) {
      this.registryCache.delete(this.registryCache.keys().next().value as string);
    }
    return known;
  }

  // Get multiple domains in batch. A name bigname cannot answer right now
  // (`stale`, `failed`) is left out, as a missing one is: callers read each
  // missing name on its own.
  async getDomains(names: string[]): Promise<{ domains: IndexerDomain[] }> {
    const results = await this.lookup(names.map((n) => n.toLowerCase()));
    const domains = results
      .map((result) => (result.status === 'ok' && result.record ? toDomain(result.record) : null))
      .filter((domain): domain is IndexerDomain => domain !== null);
    return { domains };
  }

  // Get migration status
  async getMigrationStatus(name: string): Promise<{ status: IndexerMigrationStatus | null }> {
    const { domain } = await this.getDomain(name);
    if (!domain) return { status: null };
    return {
      status: {
        name: domain.name,
        isMigrated: domain.isMigrated,
        ownerId: domain.ownerId,
        resolverId: domain.resolverId,
        parentId: domain.parentId,
        owner: domain.owner,
        resolver: domain.resolver,
        expiryDate: domain.expiryDate,
        protocol: domain.protocol,
      },
    };
  }

  // The name and up to two ancestors, read in one lookup. Null when the name
  // itself has no registration; an ancestor bigname cannot answer is left out.
  async getHierarchy(name: string): Promise<{ hierarchy: IndexerHierarchyItem | null }> {
    const levels = [name.toLowerCase()];
    while (levels.length < 3 && parentOf(levels[levels.length - 1])) {
      levels.push(parentOf(levels[levels.length - 1]));
    }
    const results = await this.lookup(levels);
    if (results[0].status !== 'ok' && results[0].status !== 'not_found') {
      throw new UpstreamError(`bigname lookup ${results[0].status} for ${name}`);
    }
    const domains = results.map((result) => (result.status === 'ok' && result.record ? toDomain(result.record) : null));
    if (!domains[0]) return { hierarchy: null };

    let parent: IndexerHierarchyItem | undefined;
    for (let i = domains.length - 1; i > 0; i--) {
      const domain = domains[i];
      parent = domain ? toHierarchyItem(domain, parent) : undefined;
    }
    return { hierarchy: toHierarchyItem(domains[0], parent) };
  }

  // Health check
  async healthCheck(): Promise<{ primary: boolean; latency: { primary?: number } }> {
    const results = { primary: false, latency: {} as { primary?: number } };
    try {
      const start = Date.now();
      const response = await fetch(`${this.endpoint}/v1/status`, {
        headers: { 'User-Agent': 'ENS-Metadata-V2/2.0.0' },
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!response.ok) throw new Error(`bigname status ${response.status}`);
      results.primary = true;
      results.latency.primary = Date.now() - start;
    } catch (error) {
      console.warn("bigname health check failed:", error);
    }
    return results;
  }

  // Build cache key for indexer responses
  static getCacheKey(operation: string, params: Record<string, any>): string {
    const sortedParams = Object.keys(params)
      .sort()
      .map((key) => `${key}:${params[key]}`)
      .join(",");

    return `ensnode:${operation}:${sortedParams}`;
  }

  // Get appropriate cache TTL based on migration status
  static getCacheTTL(_domain?: IndexerDomain): number {
    return 300; // 5 minutes
  }
}

