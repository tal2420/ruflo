import { connect } from "./neo4j-client.js";
import { allSourceEntities } from "./fixtures.js";
import { runPhase0, DEFAULT_BUSINESS_PROCESS } from "./pipeline.js";

async function main(): Promise<void> {
  const driver = connect();
  try {
    await runPhase0(driver, allSourceEntities, {
      businessProcess: DEFAULT_BUSINESS_PROCESS,
    });
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error("phase-0 failed:", err);
  process.exit(1);
});
