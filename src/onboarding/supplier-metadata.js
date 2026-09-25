import { createHash } from "node:crypto";
import { validateSupplierRedirect, validateSupplierUrl } from "../source-policy.js";
import { hasUsefulProductMetadata } from "../providers/page-content.js";
import { suggestImportMatch } from "./match-candidates.js";

function compactError(error) {
  return String(error?.message || error || "Supplier metadata discovery failed")
    .replace(/\s+/g, " ").trim().slice(0, 500);
}

function evidenceVersion(result, metadata) {
  return createHash("sha256").update(JSON.stringify({
    runId: result.runId || null,
    resolvedUrl: result.url || null,
    pageSnapshotId: result.pageSnapshotId || null,
    metadata,
  })).digest("hex");
}

function metadataFromResult(result) {
  return {
    title: result.title || "",
    canonicalUrl: result.canonicalUrl || "",
    pageImageUrl: result.pageImageUrl || "",
    productCandidates: Array.isArray(result.productCandidates) ? result.productCandidates : [],
    evidenceRecords: Array.isArray(result.evidenceRecords) ? result.evidenceRecords.slice(0, 120) : [],
    pageSnapshotId: result.pageSnapshotId || result.runId || null,
    runId: result.runId || null,
    fetchStrategy: result.fetchStrategy || null,
  };
}

export async function discoverAndMatchImportRow({
  provider,
  row,
  variants,
  supportedDomains,
  now = new Date(),
}) {
  const original = validateSupplierUrl(row.url, supportedDomains);
  let result;
  try {
    result = await provider.fetchPage(
      { url: original.toString(), discoveryMode: true, matchTerms: [] },
      { evidenceGate: hasUsefulProductMetadata, escalateInconclusive: true },
    );
  } catch (error) {
    result = { ok: false, error: compactError(error), url: original.toString() };
  }

  const attempts = Array.isArray(result?.providerAttempts) && result.providerAttempts.length
    ? result.providerAttempts
    : [{
      provider: provider.providerName || provider.constructor?.name || "provider",
      role: "discovery",
      providerRunId: result?.runId || null,
      outcome: result?.ok === false ? "FAILED" : "SUCCEEDED",
    }];

  if (!result?.ok) {
    return {
      status: "BLOCKED",
      error: compactError(result?.error || "Supplier page could not be captured"),
      resolvedUrl: result?.url || original.toString(),
      fetchedAt: result?.fetchedAt || now.toISOString(),
      attempts,
    };
  }

  let resolved;
  try {
    resolved = validateSupplierRedirect(original.toString(), result.url || original.toString(), supportedDomains);
  } catch (error) {
    return {
      status: "BLOCKED",
      error: compactError(error),
      resolvedUrl: original.toString(),
      fetchedAt: result?.fetchedAt || now.toISOString(),
      attempts,
    };
  }

  const metadata = metadataFromResult({ ...result, url: resolved.toString() });
  if (!hasUsefulProductMetadata(null, result)) {
    return {
      status: "NO_MATCH",
      error: "NO_PRODUCT_METADATA",
      resolvedUrl: resolved.toString(),
      fetchedAt: result.fetchedAt || now.toISOString(),
      metadata,
      evidenceVersion: evidenceVersion(result, metadata),
      matchReason: "NO_PRODUCT_METADATA",
      matchEvidence: [],
      attempts,
    };
  }

  const match = suggestImportMatch(row, variants, metadata);
  return {
    ...match,
    resolvedUrl: resolved.toString(),
    fetchedAt: result.fetchedAt || now.toISOString(),
    metadata,
    evidenceVersion: evidenceVersion(result, metadata),
    attempts,
  };
}
