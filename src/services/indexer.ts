import { GraphQLClient } from "graphql-request";
import { canonicalTokenId, namehash } from "../utils/ens";
import { RequestDeadlineError, UpstreamError } from "./errors";
import { timeLeftForAttempt } from "./request-budget";

// How long to remember that the indexer schema rejected a tokenId/canonicalId
// filter before probing again (the filter ships server-side; once its deploy
// lands, isolates pick it up within this window without a redeploy here).
const ID_FILTER_RECHECK_MS = 10 * 60 * 1000;

// How long an isRegistry answer is reused. Only whether the address is a
// registry is kept, never its name (see findCanonicalDomain): a registry stays
// one, so a hit is kept longer; a miss is kept briefly, so a registry deployed
// since is recognized soon after the indexer sees it.
export const REGISTRY_KNOWN_TTL_MS = 60 * 60 * 1000;
export const REGISTRY_UNKNOWN_TTL_MS = 5 * 60 * 1000;
/** Most addresses remembered per indexer; the least recently used is dropped beyond it. */
export const REGISTRY_CACHE_MAX_ENTRIES = 10_000;

/** True when the wrapped GraphQL failure is the schema rejecting the query
 *  (filter not deployed yet) rather than an outage. zigens returns
 *  `extensions.code: "VALIDATION_ERROR"` with a message that does NOT name the
 *  offending field ("Unknown field in input object: …" — verified live), so
 *  match the code plus the standard unknown-field/argument message family. The
 *  only queries routed through this check are the fixed id-filter lookups and
 *  registry(address), so a validation error can only mean the filter or that
 *  query is missing from the schema. (The id-filter lookups also filter by
 *  `registry`, so an indexer without that filter reads the same way.) */
function isSchemaValidationError(error: UpstreamError): boolean {
  const cause = (error as { cause?: unknown }).cause as
    | { response?: { errors?: Array<{ message?: string; extensions?: { code?: string } }> } }
    | undefined;
  return (cause?.response?.errors ?? []).some(
    (e) =>
      e.extensions?.code === "VALIDATION_ERROR" ||
      /unknown (field|argument)|not defined|does not exist|cannot query/i.test(e.message ?? ""),
  );
}

// ---- v1 subgraph queries (mainnet — id = namehash) ----

const V1_DOMAIN_FRAGMENT = `
  fragment DomainInfo on Domain {
    id
    name
    labelName
    labelhash
    parentId
    ownerId
    resolverId
    registrantId
    expiryDate
    createdAt
    ttl
    isMigrated
    owner {
      id
    }
    resolver {
      address
    }
    registrant {
      id
    }
  }
`;

const V1_GET_DOMAIN = `
  query GetDomain($name: String!) {
    domain(id: $name) {
      ...DomainInfo
    }
  }
  ${V1_DOMAIN_FRAGMENT}
`;

const V1_GET_DOMAINS = `
  query GetDomains($ids: [String!]!, $first: Int!) {
    domains(first: $first, where: { id_in: $ids }) {
      ...DomainInfo
    }
  }
  ${V1_DOMAIN_FRAGMENT}
`;

const V1_GET_MIGRATION_STATUS = `
  query GetMigrationStatus($id: String!) {
    domain(id: $id) {
      name
      isMigrated
      ownerId
      resolverId
      parentId
      expiryDate
      owner {
        id
      }
      resolver {
        address
      }
    }
  }
`;

const V1_GET_HIERARCHY = `
  query GetHierarchy($id: String!) {
    domain(id: $id) {
      name
      ownerId
      resolverId
      parentId
      owner {
        id
      }
      resolver {
        address
      }
      parent {
        name
        ownerId
        resolverId
        parentId
        owner {
          id
        }
        resolver {
          address
        }
        parent {
          name
          ownerId
          resolverId
          owner {
            id
          }
          resolver {
            address
          }
        }
      }
    }
  }
`;

// ---- v2 staging queries (sepolia — id = name string) ----

const V2_GET_DOMAIN = `
  query GetDomain($name: String!) {
    domain(id: $name) {
      id
      name
      labelName
      labelhash
      expiryDate
      createdAt
      ttl
      isMigrated
      protocol
      tokenId
      tokenVersion
      owner {
        id
      }
      resolver {
        address
      }
      registrant {
        id
      }
      parent {
        id
        name
      }
    }
  }
`;

const V2_GET_DOMAINS = `
  query GetDomains($names: [String!]!, $first: Int!) {
    domains(first: $first, where: { name_in: $names }) {
      id
      name
      labelName
      labelhash
      expiryDate
      createdAt
      ttl
      isMigrated
      protocol
      tokenId
      tokenVersion
      owner {
        id
      }
      resolver {
        address
      }
      registrant {
        id
      }
    }
  }
`;

// Reverse lookup for native v2 registry tokenIds (versioned labelhashes are
// irreversible from the hash alone — only the indexer, which sees registration
// events, can map them back to a name). `tokenId` matches the current version's
// exact id; `canonicalId` matches the version-bits-zeroed form, so stale
// (pre-re-registration) tokenIds still resolve to the name. Scoped to one
// registry: an id is the labelhash plus a version, so the same id exists in
// every registry that has that label (test.eth's id also matches test.<x>.eth
// in each subregistry with a `test` label). The default filter leaves out
// unreachable domains (orphaned by a subregistry repoint, an unregistered
// label or an expired ancestor), which have no name to serve, and
// unnormalized ones. The first lookup also reads the registry's name, which
// names the token (see findCanonicalDomain); the `name` variant then picks one
// row by name among a registry's alias rows.
const v2GetDomainsByIdFilter = (filterField: 'tokenId' | 'canonicalId', byName = false) => `
  query GetDomainsBy_${filterField}${byName ? '_name' : ''}($id: String!, $registry: String!${byName ? ', $name: String!' : ''}) {
${byName ? '' : '    registry(address: $registry) {\n      name\n    }\n'}    domains(first: 1, where: { registry: $registry, ${filterField}: $id${byName ? ', name: $name' : ''} }) {
      id
      name
      labelName
      labelhash
      expiryDate
      createdAt
      ttl
      isMigrated
      protocol
      tokenId
      tokenVersion
      owner {
        id
      }
      resolver {
        address
      }
      registrant {
        id
      }
    }
  }
`;

const V2_GET_DOMAINS_BY_ID = {
  tokenId: v2GetDomainsByIdFilter('tokenId'),
  canonicalId: v2GetDomainsByIdFilter('canonicalId'),
};
const V2_GET_DOMAINS_BY_ID_AND_NAME = {
  tokenId: v2GetDomainsByIdFilter('tokenId', true),
  canonicalId: v2GetDomainsByIdFilter('canonicalId', true),
};

// A v2 registry by contract address: null when the address is not one the
// indexer knows (a random contract, or a registry it has not seen yet).
const V2_GET_REGISTRY = `
  query GetRegistry($address: String!) {
    registry(address: $address) {
      address
    }
  }
`;

const V2_GET_MIGRATION_STATUS = `
  query GetMigrationStatus($id: String!) {
    domain(id: $id) {
      name
      isMigrated
      protocol
      tokenVersion
      expiryDate
      owner {
        id
      }
      resolver {
        address
      }
    }
  }
`;

const V2_GET_HIERARCHY = `
  query GetHierarchy($id: String!) {
    domain(id: $id) {
      name
      owner {
        id
      }
      resolver {
        address
      }
      parent {
        name
        owner {
          id
        }
        resolver {
          address
        }
        parent {
          name
          owner {
            id
          }
          resolver {
            address
          }
        }
      }
    }
  }
`;

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
  isMigrated?: boolean;
  tokenId?: string;
  tokenVersion?: number;
  /** zigens row provenance: "v1" = legacy ENS row, "v2" = ENSv2 row. The v2
   *  indexer can serve BOTH — classification must not equate presence with
   *  being on v2 (see utils/migration.ts classifyV2IndexerRecord). */
  protocol?: string;
  /** Set ONLY by the blockchain fallback tier (fallback.ts): the on-chain
   *  classification of the record (`unmigrated` | `migrated`; never `native`). */
  chainMigrationStatus?: string;
}

export interface IndexerResponse<T> {
  data: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
  }>;
}

export interface IndexerMigrationStatus {
  name: string;
  isMigrated: boolean;
  ownerId?: string;
  resolverId?: string;
  parentId?: string;
  owner?: { id: string };
  resolver?: { address: string };
  expiryDate?: string;
  tokenVersion?: number;
  /** zigens row provenance ("v1" | "v2") — see IndexerDomain.protocol. */
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

type ApiVersion = 'v1' | 'v2';

// The data of a response that answers its query: an object holding the queried
// root field (null, or an empty list, when the index has no match). A 200
// without it (a proxy or maintenance page, {"data":null}, {"data":{}}) is not
// an answer, so executeQuery fails the attempt as it does a transport error
// (retried, then the secondary endpoint, then UpstreamError), and no caller
// reads it as "not found".
function answerOf<T>(data: unknown, rootField: string | undefined): T {
  if (data === null || typeof data !== 'object' || Object.keys(data).length === 0
    || (rootField !== undefined && !(rootField in data))) {
    throw new Error(`malformed ensnode response: no ${rootField ?? 'data'} field`);
  }
  return data as T;
}

export class IndexerService {
  private client: GraphQLClient;
  private fallbackClient?: GraphQLClient;
  private timeout: number;
  /** Query dialect: 'v1' = ENSNode subgraph (namehash ids), 'v2' = zigens (name-string ids). */
  readonly apiVersion: ApiVersion;

  constructor(
    private config: {
      primaryEndpoint: string;
      fallbackEndpoint?: string;
      timeout?: number;
      apiVersion?: ApiVersion;
    },
  ) {
    this.timeout = config.timeout || 2000;
    this.apiVersion = config.apiVersion || 'v1';
    console.log(`[indexer] initialized with endpoint: ${config.primaryEndpoint}, version: ${this.apiVersion}, timeout: ${this.timeout}ms`);
    this.client = new GraphQLClient(config.primaryEndpoint, {
      headers: {
        "User-Agent": "ENS-Metadata-V2/2.0.0",
      },
    });

    if (config.fallbackEndpoint) {
      this.fallbackClient = new GraphQLClient(config.fallbackEndpoint, {
        headers: {
          "User-Agent": "ENS-Metadata-V2/2.0.0",
        },
      });
    }
  }

  // Resolve domain ID: v1 uses namehash, v2 uses name string
  private resolveDomainId(name: string): string {
    if (this.apiVersion === 'v2') {
      return name.toLowerCase();
    }
    return namehash(name.toLowerCase());
  }

  // Execute a GraphQL query. A transport/timeout/GraphQL failure is retried once
  // on the primary (transient blips shouldn't trip the upstream circuit-breaker),
  // then the optional secondary endpoint is tried, and finally an UpstreamError is
  // thrown. A *successful* response with empty data is NOT an error — callers map
  // a null result to NotFoundError, which the fallback layer treats as a clean
  // miss rather than an upstream failure.
  //
  // Inside a request, each attempt's timeout is cut to what is left of the
  // request's deadline (the signal aborts the fetch itself), and no attempt
  // starts once it is (nearly) spent. An attempt that fails with the deadline
  // spent ends the query in RequestDeadlineError: running out of the request's
  // time is not the indexer's failure and must not trip the circuit-breaker.
  private async executeQuery<T>(
    query: string,
    variables?: Record<string, any>,
    rootField?: keyof T & string,
  ): Promise<{ data: T; usedFallback: boolean }> {
    const request = async (client: GraphQLClient, lastError: unknown) => {
      const timeLeft = timeLeftForAttempt('ensnode request', lastError);
      const signal = AbortSignal.timeout(Math.min(this.timeout, timeLeft));
      try {
        return answerOf<T>(await client.request<T>({ document: query, variables, signal }), rootField);
      } catch (error) {
        timeLeftForAttempt('ensnode answered', error);
        throw error;
      }
    };

    // Primary, with a single retry on transient failure.
    let primaryError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return { data: await request(this.client, primaryError), usedFallback: false };
      } catch (error) {
        if (error instanceof RequestDeadlineError) throw error;
        primaryError = error;
        if (attempt === 0) console.warn(`[indexer] primary request failed (attempt ${attempt + 1}), retrying:`, error);
      }
    }
    console.warn("[indexer] primary endpoint failed after retry:", primaryError);

    if (this.fallbackClient) {
      try {
        return { data: await request(this.fallbackClient, primaryError), usedFallback: true };
      } catch (fallbackError) {
        if (fallbackError instanceof RequestDeadlineError) throw fallbackError;
        throw new UpstreamError(
          `All ensnode endpoints failed for query. Last error: ${fallbackError}`,
          { cause: fallbackError },
        );
      }
    }

    throw new UpstreamError(`ensnode request failed: ${primaryError}`, { cause: primaryError });
  }

  // Get single domain data
  async getDomain(
    name: string,
  ): Promise<{ domain: IndexerDomain | null; usedFallback: boolean }> {
    const id = this.resolveDomainId(name);
    const query = this.apiVersion === 'v2' ? V2_GET_DOMAIN : V1_GET_DOMAIN;
    const { data, usedFallback } = await this.executeQuery<{
      domain: IndexerDomain | null;
    }>(query, { name: id }, 'domain');

    return { domain: data.domain, usedFallback };
  }

  // Get domain by pre-computed namehash (for tokenId lookups). Works on BOTH
  // dialects: the v1 subgraph keys domains by namehash, and zigens' domain(id:)
  // resolves "name or namehash" (verified live against graphql.ens.dev — a
  // namehash id returns the domain; raw labelhash / versioned-tokenId forms do NOT).
  async getDomainByNamehash(
    nameHash: string,
  ): Promise<{ domain: IndexerDomain | null; usedFallback: boolean }> {
    const query = this.apiVersion === 'v2' ? V2_GET_DOMAIN : V1_GET_DOMAIN;
    const { data, usedFallback } = await this.executeQuery<{
      domain: IndexerDomain | null;
    }>(query, { name: nameHash }, 'domain');

    return { domain: data.domain, usedFallback };
  }

  // Reverse-resolve a native v2 registry tokenId (versioned labelhash) to the
  // domain the registry at `registry` holds under it, by the registry's
  // canonical name (see findCanonicalDomain), via the zigens tokenId/canonicalId filters. v2
  // dialect only — the v1 subgraph has no such tokens. Returns a clean null
  // when the deployed schema doesn't have the filters yet (they ship
  // separately, on the indexer side), so callers keep their pre-filter
  // behavior until the server deploy lands.
  async getDomainByTokenId(
    tokenId: `0x${string}`,
    registry: string,
  ): Promise<{ domain: IndexerDomain | null; usedFallback: boolean }> {
    if (this.apiVersion !== 'v2') return { domain: null, usedFallback: false };
    const id = tokenId.toLowerCase();
    const registryAddress = registry.toLowerCase();

    // Exact current-version id first (the common marketplace case) …
    const byToken = await this.findCanonicalDomain('tokenId', id, registryAddress);
    if (byToken.domain) return byToken;

    // … then the version-bits-zeroed form, which also matches ids from before a
    // re-registration bumped the token version.
    const byCanonical = await this.findCanonicalDomain(
      'canonicalId',
      canonicalTokenId(id),
      registryAddress,
    );
    return {
      domain: byCanonical.domain,
      usedFallback: byToken.usedFallback || byCanonical.usedFallback,
    };
  }

  /**
   * The domain `registry` holds under `id`, as the name the registry itself
   * hangs under. Several names can point their subregistry at one registry
   * (aliases), and the indexer then has a row per name for each of its tokens,
   * all with the same registry and id, in namehash order: the first can be a
   * name someone else owns (on staging, a token of support.vendor.eth's
   * registry came first as rin.support.shopa.eth). The token's name is
   * `<label>.<registry name>` (the bare label in the root registry). When the
   * first row is not that name, one more lookup asks for it; no such row means
   * the token has no canonical name, a miss. So is a row without a label name,
   * or one from a registry the indexer does not know.
   *
   * The registry's name is read in the same query as the rows, never from a
   * cache: a registry moved under another parent is renamed, and a name read
   * earlier would pick its old path while that is still an alias row, or miss
   * once it is gone.
   */
  private async findCanonicalDomain(
    field: 'tokenId' | 'canonicalId',
    id: string,
    registry: string,
  ): Promise<{ domain: IndexerDomain | null; usedFallback: boolean }> {
    const first = await this.queryDomainsByIdFilter(field, { id, registry }, V2_GET_DOMAINS_BY_ID[field]);
    const row = first.domain;
    if (!row) return first;
    const registryName = first.registryName;
    if (!row.labelName || typeof registryName !== 'string') {
      return { domain: null, usedFallback: first.usedFallback };
    }
    const name = registryName ? `${row.labelName}.${registryName}` : row.labelName;
    if (row.name === name) return first;
    const canonical = await this.queryDomainsByIdFilter(
      field,
      { id, registry, name },
      V2_GET_DOMAINS_BY_ID_AND_NAME[field],
    );
    return { domain: canonical.domain, usedFallback: first.usedFallback || canonical.usedFallback };
  }

  /** One `domains(where: { registry: $registry, <field>: $id })` lookup. A
   *  schema-rejects-the-filter error is remembered (per filter,
   *  ID_FILTER_RECHECK_MS) and surfaces as a clean miss; genuine outages still
   *  throw UpstreamError. */
  private idFilterUnsupportedUntil: Record<'tokenId' | 'canonicalId', number> = {
    tokenId: 0,
    canonicalId: 0,
  };

  private async queryDomainsByIdFilter(
    field: 'tokenId' | 'canonicalId',
    variables: { id: string; registry: string; name?: string },
    query: string,
  ): Promise<{ domain: IndexerDomain | null; registryName?: string; usedFallback: boolean }> {
    if (Date.now() < this.idFilterUnsupportedUntil[field]) {
      return { domain: null, usedFallback: false };
    }
    try {
      const { data, usedFallback } = await this.executeQuery<{
        domains: IndexerDomain[];
        registry?: { name: string } | null;
      }>(query, variables);
      return { domain: data.domains[0] ?? null, registryName: data.registry?.name, usedFallback };
    } catch (error) {
      if (error instanceof UpstreamError && isSchemaValidationError(error)) {
        this.idFilterUnsupportedUntil[field] = Date.now() + ID_FILTER_RECHECK_MS;
        console.warn(`[indexer] ${field}/registry filter not in deployed schema yet, treating as miss:`, error.message);
        return { domain: null, usedFallback: false };
      }
      throw error;
    }
  }

  // isRegistry answers, per lowercase address: whether it is a registry, and
  // until when to reuse that. Map order is recency (re-inserted on each hit).
  private registryCache = new Map<string, { known: boolean; until: number }>();
  private registryQueryUnsupportedUntil = 0;

  /**
   * Whether the indexer knows a v2 registry at `address`. Answers are cached
   * per isolate (REGISTRY_KNOWN_TTL_MS for a registry, REGISTRY_UNKNOWN_TTL_MS
   * for none, at most REGISTRY_CACHE_MAX_ENTRIES addresses), so a request for
   * a random address costs one indexer query per isolate in that time rather
   * than one each. Only that is cached: the registry's name, which changes when
   * it moves, is read with each token lookup (see findCanonicalDomain). An
   * outage throws UpstreamError and is not cached. False on the v1 dialect,
   * and while the deployed schema has no registry(address) query.
   */
  async isRegistry(address: string): Promise<boolean> {
    if (this.apiVersion !== 'v2' || Date.now() < this.registryQueryUnsupportedUntil) return false;
    const key = address.toLowerCase();
    const cached = this.registryCache.get(key);
    if (cached) {
      this.registryCache.delete(key);
      if (Date.now() < cached.until) {
        this.registryCache.set(key, cached);
        return cached.known;
      }
    }

    let known: boolean;
    try {
      const { data } = await this.executeQuery<{ registry: { address: string } | null }>(
        V2_GET_REGISTRY,
        { address: key },
        'registry',
      );
      known = data.registry !== null;
    } catch (error) {
      if (error instanceof UpstreamError && isSchemaValidationError(error)) {
        this.registryQueryUnsupportedUntil = Date.now() + ID_FILTER_RECHECK_MS;
        console.warn('[indexer] registry(address) query not in deployed schema yet, treating as unknown:', error.message);
        return false;
      }
      throw error;
    }

    const ttl = known ? REGISTRY_KNOWN_TTL_MS : REGISTRY_UNKNOWN_TTL_MS;
    this.registryCache.set(key, { known, until: Date.now() + ttl });
    if (this.registryCache.size > REGISTRY_CACHE_MAX_ENTRIES) {
      this.registryCache.delete(this.registryCache.keys().next().value as string);
    }
    return known;
  }

  // Get multiple domains in batch
  async getDomains(
    names: string[],
  ): Promise<{ domains: IndexerDomain[]; usedFallback: boolean }> {
    if (this.apiVersion === 'v2') {
      const ids = names.map(n => n.toLowerCase());
      const { data, usedFallback } = await this.executeQuery<{
        domains: IndexerDomain[];
      }>(V2_GET_DOMAINS, { names: ids, first: ids.length }, 'domains');
      return { domains: data.domains, usedFallback };
    }

    const nameHashes = names.map((name) => namehash(name.toLowerCase()));
    const { data, usedFallback } = await this.executeQuery<{
      domains: IndexerDomain[];
    }>(V1_GET_DOMAINS, { ids: nameHashes, first: nameHashes.length }, 'domains');

    return { domains: data.domains, usedFallback };
  }

  // Get migration status
  async getMigrationStatus(
    name: string,
  ): Promise<{ status: IndexerMigrationStatus | null; usedFallback: boolean }> {
    const id = this.resolveDomainId(name);
    const query = this.apiVersion === 'v2' ? V2_GET_MIGRATION_STATUS : V1_GET_MIGRATION_STATUS;
    const { data, usedFallback } = await this.executeQuery<{
      domain: IndexerMigrationStatus | null;
    }>(query, { id }, 'domain');

    return { status: data.domain, usedFallback };
  }

  // Get domain hierarchy
  async getHierarchy(name: string): Promise<{
    hierarchy: IndexerHierarchyItem | null;
    usedFallback: boolean;
  }> {
    const id = this.resolveDomainId(name);
    const query = this.apiVersion === 'v2' ? V2_GET_HIERARCHY : V1_GET_HIERARCHY;
    const { data, usedFallback } = await this.executeQuery<{
      domain: IndexerHierarchyItem | null;
    }>(query, { id }, 'domain');

    return { hierarchy: data.domain, usedFallback };
  }

  // Health check
  async healthCheck(): Promise<{
    primary: boolean;
    fallback?: boolean;
    latency: { primary?: number; fallback?: number };
  }> {
    const results = {
      primary: false,
      fallback: undefined as boolean | undefined,
      latency: {} as { primary?: number; fallback?: number },
    };

    const healthQuery = `query HealthCheck { domains(first: 1) { id } }`;

    // Test primary endpoint
    try {
      const start = Date.now();
      await this.client.request({
        document: healthQuery,
        signal: AbortSignal.timeout(this.timeout),
      });
      results.primary = true;
      results.latency.primary = Date.now() - start;
    } catch (error) {
      console.warn("Primary ensnode health check failed:", error);
    }

    // Test fallback endpoint if available
    if (this.fallbackClient) {
      try {
        const start = Date.now();
        await this.fallbackClient.request({
          document: healthQuery,
          signal: AbortSignal.timeout(this.timeout),
        });
        results.fallback = true;
        results.latency.fallback = Date.now() - start;
      } catch (error) {
        console.warn("Fallback ensnode health check failed:", error);
        results.fallback = false;
      }
    }

    return results;
  }

  // Build cache key for ensnode responses
  static getCacheKey(operation: string, params: Record<string, any>): string {
    const sortedParams = Object.keys(params)
      .sort()
      .map((key) => `${key}:${params[key]}`)
      .join(",");

    return `ensnode:${operation}:${sortedParams}`;
  }

  // Get appropriate cache TTL based on migration status
  static getCacheTTL(_domain?: IndexerDomain): number {
    // isMigrated from v1 subgraph means 2019 registrar migration, not v2.
    // Use a uniform TTL until v2 migration status is reliable across all networks.
    return 300; // 5 minutes
  }
}
