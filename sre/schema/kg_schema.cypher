// SREFlow knowledge graph schema — Neo4j 5.x
// Idempotent. Safe to re-run.

// ---- Canonical identity ----
CREATE CONSTRAINT canonical_id IF NOT EXISTS
  FOR (c:CanonicalEntity) REQUIRE c.id IS UNIQUE;

CREATE INDEX canonical_type IF NOT EXISTS
  FOR (c:CanonicalEntity) ON (c.canonicalType);

// ---- Source-system entities ----
// A compound key of (source, sourceId) is unique per source-system entity.
CREATE CONSTRAINT source_entity_key IF NOT EXISTS
  FOR (s:SourceEntity) REQUIRE (s.source, s.sourceId) IS UNIQUE;

CREATE INDEX source_entity_observed IF NOT EXISTS
  FOR (s:SourceEntity) ON (s.observedAt);

// ---- Business processes ----
CREATE CONSTRAINT business_process_id IF NOT EXISTS
  FOR (b:BusinessProcess) REQUIRE b.id IS UNIQUE;

CREATE INDEX business_process_tier IF NOT EXISTS
  FOR (b:BusinessProcess) ON (b.criticalityTier);

// ---- Teams / Persons / Services ----
CREATE CONSTRAINT team_id IF NOT EXISTS
  FOR (t:Team) REQUIRE t.id IS UNIQUE;

CREATE CONSTRAINT person_id IF NOT EXISTS
  FOR (p:Person) REQUIRE p.id IS UNIQUE;

// ---- Incidents / Changes / Problems / SLOs ----
CREATE CONSTRAINT incident_id IF NOT EXISTS
  FOR (i:Incident) REQUIRE i.id IS UNIQUE;

CREATE INDEX incident_opened IF NOT EXISTS
  FOR (i:Incident) ON (i.openedAt);

CREATE CONSTRAINT change_id IF NOT EXISTS
  FOR (c:Change) REQUIRE c.id IS UNIQUE;

CREATE INDEX change_closed IF NOT EXISTS
  FOR (c:Change) ON (c.closedAt);

CREATE CONSTRAINT problem_id IF NOT EXISTS
  FOR (p:Problem) REQUIRE p.id IS UNIQUE;

CREATE CONSTRAINT slo_key IF NOT EXISTS
  FOR (s:SLO) REQUIRE (s.businessProcessId, s.name) IS UNIQUE;

// ---- Config drift ----
CREATE CONSTRAINT drift_id IF NOT EXISTS
  FOR (d:ConfigDrift) REQUIRE d.id IS UNIQUE;

// ---- Network ----
CREATE CONSTRAINT subnet_cidr IF NOT EXISTS
  FOR (s:Subnet) REQUIRE s.cidr IS UNIQUE;

// ---- Documents ----
CREATE CONSTRAINT doc_id IF NOT EXISTS
  FOR (d:Document) REQUIRE d.id IS UNIQUE;

CREATE INDEX doc_type IF NOT EXISTS
  FOR (d:Document) ON (d.docType);

// ---- Reconciliation queue (entities awaiting human decision) ----
CREATE CONSTRAINT reconcile_id IF NOT EXISTS
  FOR (r:Reconciliation) REQUIRE r.id IS UNIQUE;

// ---- Useful composite indexes for common traversals ----
CREATE INDEX incident_by_bp IF NOT EXISTS
  FOR (i:Incident) ON (i.businessProcessId);

CREATE INDEX change_by_ci IF NOT EXISTS
  FOR (c:Change) ON (c.affectsCiId);

// ---- Relationship types (documentation only; Neo4j doesn't enforce) ----
// :SAME_AS            (SourceEntity → CanonicalEntity)   confidence, method, evidence
// :REALIZED_BY        (BusinessProcess → CanonicalEntity)
// :CALLS              (CanonicalEntity → CanonicalEntity)
// :RUNS_ON            (CanonicalEntity → CanonicalEntity)
// :DEPLOYED_IN        (CanonicalEntity → Datacenter/Cluster)
// :STORES_IN          (CanonicalEntity → Datastore)
// :CONNECTED_TO       (NetworkDevice/Interface ↔ NetworkDevice/Interface)
// :HAS_INTERFACE      (NetworkDevice → Interface)
// :IN_SUBNET          (Interface → Subnet)
// :IN_VLAN            (Interface → VLAN)
// :MONITORS           (AppMonitor → CanonicalEntity)
// :OWNED_BY           (* → Team / Person)
// :HAS_SLO            (BusinessProcess → SLO)
// :IMPACTED_BY        (CanonicalEntity → Change)
// :RELATED_TO         (Incident → CanonicalEntity)
// :DRIFTED_FROM       (ConfigDrift → <baseline ref>)
// :LINKED_DOC         (CanonicalEntity → Document)
// :SIMILAR_INCIDENT   (Incident → Incident)            computed via embeddings
