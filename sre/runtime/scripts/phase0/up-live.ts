// Live(-ish) Phase-0 runner.
//
// Fetches real Dynatrace entities if DT_TENANT_URL + DT_API_TOKEN are set.
// Falls back to mocked Dynatrace fixtures otherwise. BMC Helix and SolarWinds
// stay mocked until their adapters land.
//
// Usage:
//   export DT_TENANT_URL=https://abc12345.live.dynatrace.com
//   export DT_API_TOKEN=dt0c01.***   # NEVER commit; read-only, entities.read scope
//   # optional:
//   export DT_MANAGEMENT_ZONE="sandbox-checkout"
//   export DT_ENTITY_SELECTOR='type(SERVICE)'
//   npm run phase0:live
//
// The token never appears in logs or on disk; it's passed directly into the
// adapter and then only surfaces as the Authorization header value.

import { connect } from "./neo4j-client.js";
import { bmcHelixEntities, dynatraceEntities, solarWindsEntities } from "./fixtures.js";
import { fetchEntities } from "./adapters/dynatrace.js";
import { runPhase0, DEFAULT_BUSINESS_PROCESS } from "./pipeline.js";
import type { SourceEntity } from "../../src/entity-resolver/types.js";

async function resolveSources(): Promise<SourceEntity[]> {
  const tenantUrl = process.env.DT_TENANT_URL;
  const apiToken = process.env.DT_API_TOKEN;
  const selector = process.env.DT_ENTITY_SELECTOR;
  const zone = process.env.DT_MANAGEMENT_ZONE;

  let dt: SourceEntity[];
  if (tenantUrl && apiToken) {
    console.log(`▶ Fetching Dynatrace entities from ${tenantUrl}`);
    if (zone) console.log(`  management zone: ${zone}`);
    if (selector) console.log(`  selector:        ${selector}`);
    dt = await fetchEntities({
      tenantUrl,
      apiToken,
      entitySelector: selector,
      managementZone: zone,
    });
    console.log(`  ✓ fetched ${dt.length} Dynatrace entities`);
  } else {
    console.log("▶ DT_TENANT_URL / DT_API_TOKEN not set — using mocked Dynatrace fixtures");
    dt = dynatraceEntities;
  }

  // No adapters yet for these — still mocked.
  return [...dt, ...bmcHelixEntities, ...solarWindsEntities];
}

async function main(): Promise<void> {
  const sources = await resolveSources();
  const driver = connect();
  try {
    await runPhase0(driver, sources, {
      businessProcess: DEFAULT_BUSINESS_PROCESS,
    });
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error("phase-0 (live) failed:", err);
  process.exit(1);
});
