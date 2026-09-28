function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function gtin(value) {
  const digits = clean(value).replace(/[^0-9]/g, "");
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

function candidateKey(path, index) {
  return path || `candidate-${index}`;
}

function structuredRecords(result) {
  return (Array.isArray(result?.evidenceRecords) ? result.evidenceRecords : [])
    .filter((record) => record?.origin === "STRUCTURED_FIELD" && clean(record.text));
}

function groupRecords(result) {
  const groups = new Map();
  for (const record of structuredRecords(result)) {
    const path = clean(record.path);
    const jsonLd = path.match(/^(jsonld\.products\[\d+\])/i)?.[1];
    const apifyVariant = path.match(/^(variants\[\d+\])/i)?.[1];
    const scope = jsonLd || apifyVariant || "root";
    const values = groups.get(scope) || [];
    values.push(record);
    groups.set(scope, values);
  }
  if (!groups.size && result?.title) groups.set("root", []);
  return groups;
}

function lastPathPart(path) {
  return clean(path).toLowerCase().split(".").pop()?.replace(/\[\d+\]/g, "") || "";
}

function fieldValues(records, names) {
  const accepted = new Set(names.map((name) => name.toLowerCase()));
  return records
    .filter((record) => accepted.has(lastPathPart(record.path)))
    .map((record) => clean(record.text))
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function candidateFromRecords(scope, records, result, index) {
  const titles = fieldValues(records, ["name", "title", "productName"]);
  const skus = fieldValues(records, ["sku"]);
  const mpns = fieldValues(records, ["mpn", "model"]);
  const productIds = fieldValues(records, ["productid", "productId"]);
  const gtins = unique(fieldValues(records, ["gtin", "gtin8", "gtin12", "gtin13", "gtin14"])
    .map(gtin)
    .filter(Boolean));
  const brands = fieldValues(records, ["brand", "manufacturer"]);
  const optionValues = unique(fieldValues(records, ["color", "size", "name"])
    .filter((value) => value !== titles[0]));
  const title = titles[0] || (scope === "root" ? clean(result?.title) : "");
  const evidence = records.slice(0, 40).map((record) => ({
    origin: record.origin,
    path: record.path || null,
    text: clean(record.text).slice(0, 500),
    snapshotId: record.snapshotId || result?.pageSnapshotId || result?.runId || null,
    sourceUrl: record.sourceUrl || result?.url || null,
  }));
  const identityValues = unique([...skus, ...mpns, ...productIds, ...gtins]);
  return {
    key: candidateKey(scope, index),
    scope,
    title,
    brand: brands[0] || null,
    skus: unique(skus),
    mpns: unique(mpns),
    productIds: unique(productIds),
    gtins,
    optionValues,
    identityValues,
    evidence,
  };
}

export function extractSupplierMetadata(result) {
  const groups = groupRecords(result);
  const candidates = [...groups.entries()]
    .map(([scope, records], index) => candidateFromRecords(scope, records, result, index))
    .filter((candidate) => candidate.title || candidate.identityValues.length);
  const rawText = clean(result?.text).slice(0, 50_000);
  return {
    canonicalUrl: clean(result?.url) || null,
    pageTitle: clean(result?.title) || null,
    runId: result?.runId || null,
    fetchedAt: result?.fetchedAt || null,
    candidates: candidates.slice(0, 20),
    pageTextSample: rawText.slice(0, 4_000),
  };
}

export function metadataContainsExactHint(metadata, result, value) {
  const needle = clean(value);
  if (!needle) return false;
  if (metadata.candidates.some((candidate) => candidate.identityValues.includes(needle))) return true;
  return clean(result?.text).includes(needle);
}

export function hasSufficientProductMetadata(source, result) {
  if (!result?.ok) return false;
  const metadata = extractSupplierMetadata(result);
  if (metadata.candidates.some((candidate) => candidate.title && candidate.identityValues.length)) return true;
  const hints = [source?.supplierSku, source?.supplierProductId, source?.supplierVariantId]
    .map(clean)
    .filter(Boolean);
  return Boolean(metadata.pageTitle && hints.some((hint) => metadataContainsExactHint(metadata, result, hint)));
}
