import neo4j, { Driver, Session } from "neo4j-driver";

const DEFAULT_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const DEFAULT_USER = process.env.NEO4J_USER ?? "neo4j";
const DEFAULT_PASS = process.env.NEO4J_PASSWORD ?? "phase0-password-change-me";

export function connect(): Driver {
  return neo4j.driver(DEFAULT_URI, neo4j.auth.basic(DEFAULT_USER, DEFAULT_PASS), {
    connectionTimeout: 10_000,
  });
}

export async function withSession<T>(
  driver: Driver,
  fn: (s: Session) => Promise<T>,
): Promise<T> {
  const session = driver.session();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

export async function waitForNeo4j(driver: Driver, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await withSession(driver, (s) => s.run("RETURN 1"));
      return;
    } catch (_e) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("Neo4j did not become ready in time");
}
