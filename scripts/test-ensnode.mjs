#!/usr/bin/env node

// Test script to validate ensnode implementation against real subgraph
import { GraphQLClient } from 'graphql-request';

const ENSNODE_ENDPOINT = 'https://api.mainnet.ensnode.io/subgraph';

// Test queries based on our implementation
const TEST_QUERIES = {
  // Basic domain query
  getDomain: `
    query GetDomain($name: String!) {
      domain(id: $name) {
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
      }
    }
  `,

  // Migration status query
  getMigrationStatus: `
    query GetMigrationStatus($name: String!) {
      domain(id: $name) {
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
  `,

  // Hierarchy query
  getHierarchy: `
    query GetHierarchy($name: String!) {
      domain(id: $name) {
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
  `,

  // Batch domains query
  getDomains: `
    query GetDomains($names: [String!]!) {
      domains(where: { id_in: $names }) {
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
    }
  `,

  // Health check query
  healthCheck: `
    query HealthCheck {
      domains(first: 1) {
        id
        name
      }
    }
  `,

  // Get sample domains to see what's available
  getSampleDomains: `
    query GetSampleDomains {
      domains(first: 10) {
        id
        name
        labelName
        labelhash
        createdAt
        isMigrated
        ownerId
      }
    }
  `,

  // Schema introspection to understand available fields
  introspection: `
    query IntrospectSchema {
      __schema {
        types {
          name
          fields {
            name
            type {
              name
            }
          }
        }
      }
    }
  `
};

const TEST_DOMAINS = [
  'taoli.eth',        // Available in subgraph
  'skaret.eth',       // Available in subgraph
  'vitalik.eth',      // Not available (for comparison)
];

async function testQuery(client, queryName, query, variables = {}) {
  console.log(`\n🧪 Testing ${queryName}...`);
  console.log(`Variables:`, JSON.stringify(variables, null, 2));

  try {
    const start = Date.now();
    const result = await client.request(query, variables);
    const duration = Date.now() - start;

    console.log(`✅ ${queryName} succeeded (${duration}ms)`);
    console.log(`Response:`, JSON.stringify(result, null, 2));

    return { success: true, result, duration };
  } catch (error) {
    console.log(`❌ ${queryName} failed:`, error.message);
    if (error.response) {
      console.log(`Response errors:`, JSON.stringify(error.response.errors, null, 2));
    }

    return { success: false, error: error.message };
  }
}

async function testHealthCheck(client) {
  console.log(`\n💓 Testing health check...`);

  try {
    const start = Date.now();
    const result = await client.request(TEST_QUERIES.healthCheck);
    const duration = Date.now() - start;

    console.log(`✅ Health check passed (${duration}ms)`);
    console.log(`Found ${result.domains?.length || 0} domains in response`);

    return true;
  } catch (error) {
    console.log(`❌ Health check failed:`, error.message);
    return false;
  }
}

async function testSchemaIntrospection(client) {
  console.log(`\n🔍 Testing schema introspection...`);

  try {
    const result = await client.request(TEST_QUERIES.introspection);
    const domainType = result.__schema.types.find(t => t.name === 'Domain');

    if (domainType) {
      console.log(`✅ Domain type found with fields:`);
      domainType.fields.forEach(field => {
        console.log(`  - ${field.name}: ${field.type.name || 'Complex'}`);
      });
    } else {
      console.log(`❌ Domain type not found in schema`);
    }

    return domainType;
  } catch (error) {
    console.log(`❌ Schema introspection failed:`, error.message);
    return null;
  }
}

async function testBatchQuery(client) {
  const testNames = TEST_DOMAINS.slice(0, 3); // Test with first 3 domains

  console.log(`\n📦 Testing batch query with ${testNames.length} domains...`);

  const result = await testQuery(client, 'Batch Domains', TEST_QUERIES.getDomains, {
    names: testNames
  });

  if (result.success) {
    const domains = result.result.domains || [];
    console.log(`Found ${domains.length} domains out of ${testNames.length} requested`);

    // Analyze results
    testNames.forEach(name => {
      const found = domains.find(d => d.name === name);
      if (found) {
        console.log(`  ✅ ${name}: Found (migrated: ${found.isMigrated})`);
      } else {
        console.log(`  ❌ ${name}: Not found`);
      }
    });
  }

  return result;
}

async function main() {
  console.log(`🚀 Testing ENS Ensnode Implementation`);
  console.log(`Endpoint: ${ENSNODE_ENDPOINT}\n`);

  const client = new GraphQLClient(ENSNODE_ENDPOINT, {
    headers: {
      'User-Agent': 'ENS-Metadata-V2-Test/1.0.0',
    },
  });

  // Test health check first
  const healthOk = await testHealthCheck(client);
  if (!healthOk) {
    console.log(`\n❌ Health check failed - endpoint may be down or incorrect`);
    return;
  }

  // Test schema introspection
  await testSchemaIntrospection(client);

  // Get sample domains to see what's actually in the subgraph
  console.log(`\n📋 Getting sample domains from subgraph...`);
  await testQuery(client, 'Sample Domains', TEST_QUERIES.getSampleDomains);

  const results = [];

  // Test individual domain queries
  for (const domain of TEST_DOMAINS) {
    const result = await testQuery(client, `Domain: ${domain}`, TEST_QUERIES.getDomain, {
      name: domain
    });
    results.push({ domain, ...result });

    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Test by actual ID from the sample data
  console.log(`\n🔍 Testing with actual domain IDs...`);
  const actualDomainId = '0x0000044a32f0964f4bf8fb4d017e230ad33595c0e149b6b2d0c34b733dcf906a'; // taoli.eth
  await testQuery(client, `Domain by ID: taoli.eth`, TEST_QUERIES.getDomain, {
    name: actualDomainId
  });

  // Test migration status queries
  console.log(`\n🔄 Testing migration status queries...`);
  for (const domain of TEST_DOMAINS.slice(0, 2)) {
    await testQuery(client, `Migration: ${domain}`, TEST_QUERIES.getMigrationStatus, {
      name: domain
    });
  }

  // Test hierarchy queries
  console.log(`\n🏗️  Testing hierarchy queries...`);
  for (const domain of TEST_DOMAINS.slice(0, 2)) {
    await testQuery(client, `Hierarchy: ${domain}`, TEST_QUERIES.getHierarchy, {
      name: domain
    });
  }

  // Test batch query
  await testBatchQuery(client);

  // Summary
  console.log(`\n📊 SUMMARY`);
  console.log(`==========`);

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log(`✅ Successful queries: ${successful}`);
  console.log(`❌ Failed queries: ${failed}`);

  if (successful > 0) {
    console.log(`\n🎉 Ensnode integration appears to be working!`);

    // Analyze successful results
    const successfulDomains = results.filter(r => r.success && r.result?.domain);
    if (successfulDomains.length > 0) {
      console.log(`\nFound domains:`);
      successfulDomains.forEach(({ domain, result }) => {
        const domainData = result.domain;
        console.log(`  - ${domain}:`);
        console.log(`    • Owner: ${domainData.owner?.id || 'None'}`);
        console.log(`    • Migrated: ${domainData.isMigrated || false}`);
        console.log(`    • Resolver: ${domainData.resolver?.address || 'None'}`);
        if (domainData.expiryDate) {
          console.log(`    • Expires: ${new Date(domainData.expiryDate).toLocaleDateString()}`);
        }
      });
    }
  } else {
    console.log(`\n⚠️  No successful queries - check endpoint and query format`);
  }

  console.log(`\nTest completed at ${new Date().toISOString()}`);
}

// Handle errors gracefully
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
  process.exit(1);
});

main().catch(console.error);