import { getStore } from "@netlify/blobs";

const APP_VERSION = "1.1";
const SCHEMA_VERSION = 2;
const STORE_NAME = "arshjulet-shared";
const MAX_BACKUPS = 100;
const DEPLOY_CONTEXT = process.env.CONTEXT || "dev";
const IS_PRODUCTION = DEPLOY_CONTEXT === "production";
const DATA_SCOPE = IS_PRODUCTION ? "production" : `preview/${process.env.DEPLOY_ID || DEPLOY_CONTEXT}`;
const DATA_KEY = `${DATA_SCOPE}/state`;
const BACKUP_PREFIX = `${DATA_SCOPE}/backups/`;

const json = (value, status = 200, headers = {}) => Response.json(value, {
  status,
  headers: {
    "cache-control": "no-store",
    ...headers,
  },
});

const uid = () => crypto.randomUUID();

function defaults() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    updatedAt: new Date().toISOString(),
    settings: {
      eyebrow: "Verksamhetsplanering",
      title: "Årshjulet",
      subtitle: "Samla årets aktiviteter i en tydlig rytm.",
      frameColor: "#d8ddd9",
    },
    types: [
      { id: uid(), name: "Ledning", color: "#2f765f" },
      { id: uid(), name: "Styrelse", color: "#4e6fa9" },
      { id: uid(), name: "Ekonomi", color: "#bb8b2e" },
      { id: uid(), name: "Medarbetare", color: "#8265a6" },
      { id: uid(), name: "Marknad", color: "#cf6a4c" },
    ],
    owners: [
      { id: uid(), name: "VD" },
      { id: uid(), name: "Ekonomiansvarig" },
      { id: uid(), name: "HR-ansvarig" },
      { id: uid(), name: "Marknadsansvarig" },
      { id: uid(), name: "Verksamhetsansvarig" },
    ],
    activities: [],
  };
}

function migrate(input) {
  if (!input || typeof input !== "object") return defaults();
  const value = structuredClone(input);
  if (!Array.isArray(value.types)) value.types = [];
  if (!Array.isArray(value.owners)) value.owners = [];
  if (!Array.isArray(value.activities)) value.activities = [];
  if (!value.settings || typeof value.settings !== "object") value.settings = {};
  value.settings = {
    eyebrow: String(value.settings.eyebrow || "Verksamhetsplanering").slice(0, 100),
    title: String(value.settings.title || "Årshjulet").slice(0, 100),
    subtitle: String(value.settings.subtitle || "Samla årets aktiviteter i en tydlig rytm.").slice(0, 180),
    frameColor: /^#[0-9a-f]{6}$/i.test(value.settings.frameColor || "") ? value.settings.frameColor : "#d8ddd9",
  };
  value.schemaVersion = SCHEMA_VERSION;
  value.revision = Number.isInteger(value.revision) ? value.revision : 0;
  value.updatedAt = value.updatedAt || new Date().toISOString();
  return value;
}

function validate(value) {
  if (!value || typeof value !== "object") return "Ogiltig data.";
  if (!Array.isArray(value.types) || !Array.isArray(value.owners) || !Array.isArray(value.activities)) return "Listorna saknas.";
  if (value.types.length > 500 || value.owners.length > 500 || value.activities.length > 20000) return "Datamängden är för stor.";
  if (JSON.stringify(value).length > 4_000_000) return "Datamängden är för stor.";
  return "";
}

async function pruneBackups(store) {
  const { blobs } = await store.list({ prefix: BACKUP_PREFIX });
  if (blobs.length <= MAX_BACKUPS) return;
  const old = blobs.sort((a, b) => a.key.localeCompare(b.key)).slice(0, blobs.length - MAX_BACKUPS);
  await Promise.all(old.map((entry) => store.delete(entry.key)));
}

async function readCurrent(store, cachedEtag) {
  const entry = await store.getWithMetadata(DATA_KEY, {
    consistency: "strong",
    type: "json",
    ...(cachedEtag ? { etag: cachedEtag } : {}),
  });
  if (entry) return entry;

  let initial = defaults();
  if (!IS_PRODUCTION) {
    const production = await store.get("production/state", { consistency: "strong", type: "json" });
    if (production) initial = migrate(production);
  }
  const created = await store.setJSON(DATA_KEY, initial, { onlyIfNew: true });
  if (created.modified) return { data: initial, etag: created.etag, metadata: {} };
  return store.getWithMetadata(DATA_KEY, { consistency: "strong", type: "json" });
}

export default async (request) => {
  const store = getStore(STORE_NAME);

  try {
    if (request.method === "GET") {
      const cachedEtag = request.headers.get("if-none-match") || "";
      const entry = await readCurrent(store, cachedEtag);
      if (cachedEtag && entry && entry.etag === cachedEtag && entry.data === null) {
        return new Response(null, { status: 304, headers: { etag: entry.etag, "cache-control": "no-store" } });
      }
      const migrated = migrate(entry.data);
      let etag = entry.etag;
      if (JSON.stringify(migrated) !== JSON.stringify(entry.data)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await store.setJSON(`${BACKUP_PREFIX}${stamp}-pre-migration-v${entry.data.schemaVersion || 1}`, entry.data);
        const result = await store.setJSON(DATA_KEY, migrated, { onlyIfMatch: entry.etag });
        if (result.modified) etag = result.etag;
      }
      return json({ data: migrated, appVersion: APP_VERSION }, 200, { etag });
    }

    if (request.method === "PUT") {
      const payload = await request.json();
      if (payload.appVersion !== APP_VERSION) {
        return json({ error: "Appen har uppdaterats. Ladda om sidan innan du sparar igen.", code: "APP_VERSION" }, 426);
      }
      const problem = validate(payload.data);
      if (problem) return json({ error: problem, code: "VALIDATION" }, 400);

      const current = await readCurrent(store);
      if (!payload.etag || payload.etag !== current.etag) {
        return json({ error: "Någon annan har sparat en nyare version.", code: "CONFLICT", current: migrate(current.data) }, 409, { etag: current.etag });
      }

      const next = migrate(payload.data);
      next.revision = (Number(current.data.revision) || 0) + 1;
      next.updatedAt = new Date().toISOString();

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await store.setJSON(`${BACKUP_PREFIX}${stamp}-r${String(current.data.revision || 0).padStart(6, "0")}`, current.data);
      const result = await store.setJSON(DATA_KEY, next, { onlyIfMatch: current.etag });
      if (!result.modified) {
        const latest = await readCurrent(store);
        return json({ error: "Någon annan hann spara före dig.", code: "CONFLICT", current: migrate(latest.data) }, 409, { etag: latest.etag });
      }
      await pruneBackups(store);
      return json({ data: next, appVersion: APP_VERSION }, 200, { etag: result.etag });
    }

    return json({ error: "Metoden stöds inte." }, 405, { allow: "GET, PUT" });
  } catch (error) {
    console.error("Shared data error", error);
    return json({ error: "Den gemensamma datan kunde inte hanteras. Försök igen." }, 500);
  }
};

export const config = { path: "/api/data" };
