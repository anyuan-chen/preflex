// setup-es-indices.ts — Creates ES indices and bulk-loads Clee's Keys data
//
// Mirrors the same data that prisma/seed.ts puts in Postgres, so the ES
// cluster matches what pgSync would produce in production. Uses the _bulk
// API the same way scenarios/*/data.sh do in the sandbox.

const ES_URL = process.env.ES_URL ?? "http://localhost:9200";
const ES_USER = process.env.ES_USER ?? "elastic";
const ES_PASSWORD = process.env.ES_PASSWORD ?? "changeme";

const auth = ES_USER
  ? { Authorization: `Basic ${Buffer.from(`${ES_USER}:${ES_PASSWORD}`).toString("base64")}` }
  : {};

const headers = { "Content-Type": "application/json", ...auth };
const ndjsonHeaders = { "Content-Type": "application/x-ndjson", ...auth };

// ── Shared data pools (same as prisma/seed.ts + scenarios/*/data.sh) ────────

const KEY_TYPES = ["house", "car", "safe", "padlock", "mailbox", "cabinet", "deadbolt"];
const STORES = ["main-shop", "downtown", "mobile-van"];
const ORDER_STATUSES = ["pending", "cutting", "ready", "picked-up"];
const DESCRIPTIONS = [
  "House key copy",
  "Schlage deadbolt rekey",
  "Car key duplicate",
  "Padlock key replacement",
  "Mailbox key copy",
  "Safe combination reset and new key",
  "Cabinet lock rekey",
  "Master key system setup",
  "High-security key cut",
  "Transponder key programming",
];

const SERVICE_TYPES = ["key-cutting", "lockout", "rekey", "safe-install"];
const TECHNICIANS = ["tech-001", "tech-002", "tech-003", "tech-004"];
const LOG_MESSAGES = [
  "Customer locked out, deadbolt rekey completed",
  "Key cutting for Schlage SC1 blank",
  "Emergency lockout service, picked wafer lock",
  "Safe combination reset and new key cut",
  "Transponder key programming for Honda Civic",
  "Master key system installation for office building",
  "Broken key extraction from Yale deadbolt",
  "High-security Medeco key duplication",
  "Cabinet lock rekey, 4 locks total",
  "Automotive lockout, slim jim entry",
];

const BRANDS = ["Schlage", "Kwikset", "Yale", "Medeco", "Mul-T-Lock", "ASSA"];
const LOCATIONS = ["main-shop", "downtown", "warehouse"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDate(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - Math.floor(Math.random() * daysBack));
  d.setHours(Math.floor(Math.random() * 24), Math.floor(Math.random() * 60));
  return d.toISOString();
}

// ── Index definitions with mappings ─────────────────────────────────────────

const INDICES: Record<string, { properties: Record<string, unknown> }> = {
  orders: {
    properties: {
      order_date: { type: "date" },
      description: { type: "text", fields: { keyword: { type: "keyword" } } },
      key_type: { type: "keyword" },
      price: { type: "float" },
      status: { type: "keyword" },
      customer_id: { type: "keyword" },
      store: { type: "keyword" },
    },
  },
  "service-logs": {
    properties: {
      timestamp: { type: "date" },
      message: { type: "text" },
      service_type: { type: "keyword" },
      technician: { type: "keyword" },
      job_id: { type: "keyword" },
      duration_ms: { type: "float" },
    },
  },
  "key-inventory": {
    properties: {
      sku: { type: "keyword" },
      brand: { type: "keyword" },
      key_type: { type: "keyword" },
      description: { type: "text", fields: { keyword: { type: "keyword" } } },
      quantity: { type: "integer" },
      price: { type: "float" },
      location: { type: "keyword" },
      updated_at: { type: "date" },
    },
  },
  appointments: {
    properties: {
      appointment_date: { type: "date" },
      customer_id: { type: "keyword" },
      service_type: { type: "keyword" },
      technician: { type: "keyword" },
      status: { type: "keyword" },
      notes: { type: "text" },
      address: { type: "text", fields: { keyword: { type: "keyword" } } },
    },
  },
  "customer-billing": {
    properties: {
      invoice_date: { type: "date" },
      customer_id: { type: "keyword" },
      description: { type: "text", fields: { keyword: { type: "keyword" } } },
      amount: { type: "float" },
      status: { type: "keyword" },
      payment_method: { type: "keyword" },
    },
  },
};

// ── Data generators (one per index) ─────────────────────────────────────────

function generateOrders(count: number): string {
  let bulk = "";
  for (let i = 0; i < count; i++) {
    bulk += JSON.stringify({ index: { _index: "orders" } }) + "\n";
    bulk += JSON.stringify({
      order_date: randomDate(30),
      description: pick(DESCRIPTIONS),
      key_type: pick(KEY_TYPES),
      price: parseFloat((Math.random() * 200 + 5).toFixed(2)),
      status: pick(ORDER_STATUSES),
      customer_id: `cust-${Math.floor(Math.random() * 500)}`,
      store: pick(STORES),
    }) + "\n";
  }
  return bulk;
}

function generateServiceLogs(count: number): string {
  let bulk = "";
  for (let i = 0; i < count; i++) {
    bulk += JSON.stringify({ index: { _index: "service-logs" } }) + "\n";
    bulk += JSON.stringify({
      timestamp: randomDate(30),
      message: pick(LOG_MESSAGES),
      service_type: pick(SERVICE_TYPES),
      technician: pick(TECHNICIANS),
      job_id: `job-${Math.random().toString(36).slice(2, 10)}`,
      duration_ms: parseFloat((Math.random() * 5000).toFixed(1)),
    }) + "\n";
  }
  return bulk;
}

function generateInventory(count: number): string {
  let bulk = "";
  for (let i = 0; i < count; i++) {
    bulk += JSON.stringify({ index: { _index: "key-inventory" } }) + "\n";
    bulk += JSON.stringify({
      sku: `SKU-${String(i).padStart(4, "0")}`,
      brand: pick(BRANDS),
      key_type: pick(KEY_TYPES),
      description: `${pick(BRANDS)} ${pick(KEY_TYPES)} key blank`,
      quantity: Math.floor(Math.random() * 100),
      price: parseFloat((Math.random() * 50 + 1).toFixed(2)),
      location: pick(LOCATIONS),
      updated_at: randomDate(14),
    }) + "\n";
  }
  return bulk;
}

function generateAppointments(count: number): string {
  let bulk = "";
  for (let i = 0; i < count; i++) {
    bulk += JSON.stringify({ index: { _index: "appointments" } }) + "\n";
    bulk += JSON.stringify({
      appointment_date: randomDate(14),
      customer_id: `cust-${Math.floor(Math.random() * 500)}`,
      service_type: pick(SERVICE_TYPES),
      technician: pick(TECHNICIANS),
      status: pick(["scheduled", "confirmed", "completed", "cancelled"]),
      notes: Math.random() > 0.5 ? "Customer requested morning slot" : null,
      address: `${Math.floor(Math.random() * 9999)} Main St`,
    }) + "\n";
  }
  return bulk;
}

function generateBilling(count: number): string {
  let bulk = "";
  for (let i = 0; i < count; i++) {
    bulk += JSON.stringify({ index: { _index: "customer-billing" } }) + "\n";
    bulk += JSON.stringify({
      invoice_date: randomDate(60),
      customer_id: `cust-${Math.floor(Math.random() * 500)}`,
      description: pick(DESCRIPTIONS),
      amount: parseFloat((Math.random() * 300 + 10).toFixed(2)),
      status: pick(["unpaid", "paid", "overdue"]),
      payment_method: pick(["cash", "card", "check"]),
    }) + "\n";
  }
  return bulk;
}

// ── ES operations ───────────────────────────────────────────────────────────

async function waitForEs(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${ES_URL}/_cluster/health`, { headers });
      if (res.ok) {
        const health = await res.json() as { status: string };
        console.log(`  ES cluster health: ${health.status}`);
        return;
      }
    } catch {
      // not ready
    }
    console.log("  Waiting for ES...");
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("ES did not become ready in 60s");
}

async function createIndex(
  name: string,
  mappings: { properties: Record<string, unknown> },
): Promise<void> {
  // Delete if exists
  await fetch(`${ES_URL}/${name}`, { method: "DELETE", headers }).catch(() => {});

  const res = await fetch(`${ES_URL}/${name}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create index ${name}: ${err}`);
  }
}

async function bulkLoad(index: string, ndjson: string): Promise<number> {
  const res = await fetch(`${ES_URL}/_bulk`, {
    method: "POST",
    headers: ndjsonHeaders,
    body: ndjson,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bulk load failed for ${index}: ${err}`);
  }

  const result = await res.json() as { errors: boolean; items: unknown[] };
  if (result.errors) {
    throw new Error(`Bulk load had errors for ${index}`);
  }

  return result.items.length;
}

async function refreshIndex(index: string): Promise<void> {
  await fetch(`${ES_URL}/${index}/_refresh`, { method: "POST", headers });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Setting up Clee's Keys ES indices at ${ES_URL}...`);
  console.log();

  await waitForEs();

  const plan: Array<{
    index: string;
    count: number;
    generate: (n: number) => string;
  }> = [
    { index: "orders", count: 1000, generate: generateOrders },
    { index: "service-logs", count: 800, generate: generateServiceLogs },
    { index: "key-inventory", count: 200, generate: generateInventory },
    { index: "appointments", count: 300, generate: generateAppointments },
    { index: "customer-billing", count: 500, generate: generateBilling },
  ];

  for (const { index, count, generate } of plan) {
    // Create index with mappings
    await createIndex(index, INDICES[index]);

    // Generate and bulk-load data
    const ndjson = generate(count);
    const loaded = await bulkLoad(index, ndjson);
    await refreshIndex(index);

    console.log(`  ${index}: created index + loaded ${loaded} docs`);
  }

  console.log();
  console.log("Setup complete — 2,800 docs across 5 indices.");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
