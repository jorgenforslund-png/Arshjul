import { getStore } from "@netlify/blobs";

const APP_VERSION = "1.8";
const SCHEMA_VERSION = 4;
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
      backgroundColor: "#f1efe9",
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
  const sourceSchema = Number(input.schemaVersion) || 1;
  const value = structuredClone(input);
  if (!Array.isArray(value.types)) value.types = [];
  if (!Array.isArray(value.owners)) value.owners = [];
  if (!Array.isArray(value.activities)) value.activities = [];
  if (!value.settings || typeof value.settings !== "object") value.settings = {};
  const backgroundColor = value.settings.backgroundColor || value.settings.frameColor || "#f1efe9";
  value.settings = {
    eyebrow: String(value.settings.eyebrow || "Verksamhetsplanering").slice(0, 100),
    title: String(value.settings.title || "Årshjulet").slice(0, 100),
    subtitle: String(value.settings.subtitle || "Samla årets aktiviteter i en tydlig rytm.").slice(0, 180),
    backgroundColor: /^#[0-9a-f]{6}$/i.test(backgroundColor) ? backgroundColor : "#f1efe9",
  };
  if (sourceSchema < 3) {
    value.activities = value.activities.map((activity) => {
      if (!activity || !activity.seriesId || !activity.date) return activity;
      const date = new Date(`${activity.date}T12:00:00`);
      const day = date.getDay();
      if (day === 6) date.setDate(date.getDate() + 2);
      if (day === 0) date.setDate(date.getDate() + 1);
      return { ...activity, date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` };
    });
  }
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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function mergeCollection(collection, baseItems, localItems, remoteItems, conflicts) {
  const base = new Map(baseItems.map((item) => [item.id, item]));
  const local = new Map(localItems.map((item) => [item.id, item]));
  const remote = new Map(remoteItems.map((item) => [item.id, item]));
  const ids = [...new Set([...base.keys(), ...remote.keys(), ...local.keys()])];
  const result = [];

  for (const id of ids) {
    const before = base.get(id);
    const mine = local.get(id);
    const theirs = remote.get(id);
    const mineChanged = !same(mine, before);
    const theirsChanged = !same(theirs, before);
    let chosen = theirs;

    if (mineChanged && !theirsChanged) chosen = mine;
    if (mineChanged && theirsChanged) {
      if (same(mine, theirs)) chosen = mine;
      else {
        conflicts.push({
          collection,
          id,
          base: before ?? null,
          local: mine ?? null,
          remote: theirs ?? null,
        });
      }
    }
    if (chosen !== undefined) result.push(chosen);
  }
  return result;
}

function mergeSettings(base, local, remote, conflicts) {
  const result = { ...remote };
  const keys = [...new Set([...Object.keys(base), ...Object.keys(remote), ...Object.keys(local)])];
  for (const key of keys) {
    const mineChanged = !same(local[key], base[key]);
    const theirsChanged = !same(remote[key], base[key]);
    if (mineChanged && !theirsChanged) result[key] = local[key];
    else if (mineChanged && theirsChanged && !same(local[key], remote[key])) {
      conflicts.push({ collection: "settings", id: key, base: base[key] ?? null, local: local[key] ?? null, remote: remote[key] ?? null });
    }
  }
  return result;
}

function mergeStates(baseInput, localInput, remoteInput) {
  const base = migrate(baseInput);
  const local = migrate(localInput);
  const remote = migrate(remoteInput);
  const conflicts = [];
  const merged = structuredClone(remote);
  merged.settings = mergeSettings(base.settings, local.settings, remote.settings, conflicts);
  merged.types = mergeCollection("types", base.types, local.types, remote.types, conflicts);
  merged.owners = mergeCollection("owners", base.owners, local.owners, remote.owners, conflicts);
  merged.activities = mergeCollection("activities", base.activities, local.activities, remote.activities, conflicts);
  return { merged, conflicts };
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
      const baseProblem = validate(payload.baseData);
      if (baseProblem) return json({ error: "Synkroniseringsunderlaget saknas. Ladda om sidan.", code: "BASE_DATA" }, 400);

      const local = migrate(payload.data);
      let current = await readCurrent(store);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const remote = migrate(current.data);
        let next = local;
        if (!payload.etag || payload.etag !== current.etag) {
          const merge = mergeStates(payload.baseData, local, remote);
          if (merge.conflicts.length) {
            return json({
              error: "Samma information har ändrats av två användare.",
              code: "CONFLICT",
              current: remote,
              merged: merge.merged,
              conflicts: merge.conflicts,
            }, 409, { etag: current.etag });
          }
          next = merge.merged;
        }

        if (same(next.settings, remote.settings) && same(next.types, remote.types) && same(next.owners, remote.owners) && same(next.activities, remote.activities)) {
          return json({ data: remote, appVersion: APP_VERSION, autoMerged: payload.etag !== current.etag }, 200, { etag: current.etag });
        }

        next.revision = (Number(remote.revision) || 0) + 1;
        next.updatedAt = new Date().toISOString();
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await store.setJSON(`${BACKUP_PREFIX}${stamp}-${crypto.randomUUID().slice(0, 8)}-r${String(remote.revision || 0).padStart(6, "0")}`, remote);
        const result = await store.setJSON(DATA_KEY, next, { onlyIfMatch: current.etag });
        if (result.modified) {
          await pruneBackups(store);
          return json({ data: next, appVersion: APP_VERSION, autoMerged: payload.etag !== current.etag }, 200, { etag: result.etag });
        }
        current = await readCurrent(store);
      }

      return json({ error: "Flera ändringar kom in samtidigt. Försök igen.", code: "BUSY" }, 409, { etag: current.etag });
    }

    return json({ error: "Metoden stöds inte." }, 405, { allow: "GET, PUT" });
  } catch (error) {
    console.error("Shared data error", error);
    return json({ error: "Den gemensamma datan kunde inte hanteras. Försök igen." }, 500);
  }
};

export const config = { path: "/api/data" };

export { defaults, mergeStates, migrate, validate };
