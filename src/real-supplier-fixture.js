const DATASET_ROLES = new Set(["development", "holdout"]);
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

function normalizedUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function supplierIdentityKeys(testCase) {
  const host = new URL(testCase.source.url).hostname.toLowerCase();
  return ["supplierSku", "supplierProductId", "supplierVariantId"]
    .map((field) => testCase.source[field] && `${host}|${field}|${String(testCase.source[field]).trim().toLowerCase()}`)
    .filter(Boolean);
}

function requireUniqueCases(cases) {
  const ids = new Set();
  const urls = new Set();
  for (const testCase of cases) {
    if (!testCase?.id || typeof testCase.id !== "string") throw new Error("REAL_SUPPLIER_CASE_ID_REQUIRED");
    if (ids.has(testCase.id)) throw new Error(`REAL_SUPPLIER_DUPLICATE_CASE_ID:${testCase.id}`);
    ids.add(testCase.id);

    if (!testCase?.source?.url) throw new Error(`REAL_SUPPLIER_CASE_URL_REQUIRED:${testCase.id}`);
    const url = normalizedUrl(testCase.source.url);
    if (urls.has(url)) throw new Error(`REAL_SUPPLIER_DUPLICATE_CASE_URL:${testCase.id}`);
    urls.add(url);
  }
}

export function normalizeRealSupplierFixture(payload, {
  requestedRole,
  expectedFixtureSha256,
  actualFixtureSha256,
  expectedBaselineSha,
} = {}) {
  const legacyDevelopmentFixture = Array.isArray(payload);
  const cases = legacyDevelopmentFixture ? payload : payload?.cases;
  const datasetRole = legacyDevelopmentFixture ? "development" : payload?.datasetRole;

  if (!Array.isArray(cases)) throw new Error("REAL_SUPPLIER_FIXTURE_CASES_REQUIRED");
  if (!DATASET_ROLES.has(datasetRole)) throw new Error("INVALID_REAL_SUPPLIER_DATASET_ROLE");
  if (requestedRole && requestedRole !== datasetRole) {
    throw new Error(`REAL_SUPPLIER_DATASET_ROLE_MISMATCH:${requestedRole}:${datasetRole}`);
  }
  if (expectedFixtureSha256 && expectedFixtureSha256 !== actualFixtureSha256) {
    throw new Error("REAL_SUPPLIER_FIXTURE_SHA256_MISMATCH");
  }
  requireUniqueCases(cases);

  const frozenAgainstCommit = legacyDevelopmentFixture ? null : payload.frozenAgainstCommit || null;
  if (datasetRole === "holdout") {
    if (payload.schemaVersion !== 1) throw new Error("REAL_SUPPLIER_HOLDOUT_SCHEMA_VERSION_UNSUPPORTED");
    if (!COMMIT_SHA_PATTERN.test(frozenAgainstCommit || "")) {
      throw new Error("REAL_SUPPLIER_HOLDOUT_BASELINE_REQUIRED");
    }
    if (!payload.frozenAt || Number.isNaN(Date.parse(payload.frozenAt))) {
      throw new Error("REAL_SUPPLIER_HOLDOUT_FROZEN_AT_REQUIRED");
    }
    if (expectedBaselineSha && frozenAgainstCommit !== expectedBaselineSha) {
      throw new Error("REAL_SUPPLIER_HOLDOUT_BASELINE_MISMATCH");
    }
    if (!payload.selectionProtocol || typeof payload.selectionProtocol !== "string") {
      throw new Error("REAL_SUPPLIER_HOLDOUT_SELECTION_PROTOCOL_REQUIRED");
    }
  }

  return {
    cases,
    datasetRole,
    metadata: legacyDevelopmentFixture ? null : {
      schemaVersion: payload.schemaVersion || null,
      frozenAt: payload.frozenAt || null,
      frozenAgainstCommit,
      selectionProtocol: payload.selectionProtocol || null,
    },
  };
}

export function assertHoldoutDisjoint(holdoutCases, developmentCases) {
  const developmentIds = new Set(developmentCases.map((testCase) => testCase.id));
  const developmentUrls = new Set(developmentCases.map((testCase) => normalizedUrl(testCase.source.url)));
  const developmentIdentities = new Set(developmentCases.flatMap(supplierIdentityKeys));
  for (const testCase of holdoutCases) {
    if (developmentIds.has(testCase.id)) throw new Error(`REAL_SUPPLIER_HOLDOUT_ID_OVERLAP:${testCase.id}`);
    if (developmentUrls.has(normalizedUrl(testCase.source.url))) {
      throw new Error(`REAL_SUPPLIER_HOLDOUT_URL_OVERLAP:${testCase.id}`);
    }
    if (supplierIdentityKeys(testCase).some((identity) => developmentIdentities.has(identity))) {
      throw new Error(`REAL_SUPPLIER_HOLDOUT_IDENTITY_OVERLAP:${testCase.id}`);
    }
  }
}
