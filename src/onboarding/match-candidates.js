function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function tokens(value) {
  return new Set(clean(value).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
}

function validGtin(value) {
  const digits = clean(value).replace(/[^0-9]/g, "");
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  const numbers = [...digits].map(Number);
  const check = numbers.pop();
  const sum = numbers.reverse().reduce((total, digit, index) =>
    total + digit * (index % 2 === 0 ? 3 : 1), 0);
  const expected = (10 - (sum % 10)) % 10;
  return expected === check ? digits : null;
}

function candidateIdentities(candidate) {
  const base = {
    ...candidate,
    supplierSku: clean(candidate.sku),
    supplierVariantId: "",
    displayName: clean(candidate.title),
  };
  const offers = Array.isArray(candidate.offers) ? candidate.offers : [];
  return [
    base,
    ...offers.map((offer) => ({
      ...candidate,
      offer,
      supplierSku: clean(offer.sku || candidate.sku),
      supplierVariantId: clean(offer.sku),
      displayName: clean(offer.name || candidate.title),
    })),
  ];
}

function optionConflict(variant, candidate) {
  const optionMap = new Map((variant.selectedOptions || []).map((option) => [
    normalized(option.name),
    normalized(option.value),
  ]));
  for (const [field, keys] of [
    ["color", ["color", "colour"]],
    ["size", ["size"]],
  ]) {
    const actual = normalized(candidate[field]);
    if (!actual) continue;
    const expected = keys.map((key) => optionMap.get(key)).find(Boolean);
    if (expected && actual !== expected) return field.toUpperCase() + "_CONFLICT";
  }
  const pack = (value) => {
    const match = clean(value).toLowerCase().match(/\b(\d+)\s*(?:pack|pk|count|ct|pcs?|pieces?)\b/);
    return match ? Number(match[1]) : null;
  };
  const expectedPack = [...optionMap.values()].map(pack).find((value) => value != null);
  const actualPack = [candidate.displayName, candidate.title, candidate.offer?.name]
    .map(pack).find((value) => value != null);
  if (expectedPack != null && actualPack != null && expectedPack !== actualPack) return "PACK_CONFLICT";
  return null;
}

function explicitCandidateMatch(row, candidate) {
  const skuHint = normalized(row.supplierSkuHint);
  const mpnHint = normalized(row.mpnHint);
  const barcodeHint = validGtin(row.barcodeHint);
  const candidateGtins = (candidate.gtins || []).map(validGtin).filter(Boolean);
  if (skuHint && normalized(candidate.supplierSku) !== skuHint) return false;
  if (mpnHint && normalized(candidate.mpn) !== mpnHint) return false;
  if (barcodeHint && candidateGtins.length && !candidateGtins.includes(barcodeHint)) return false;
  return Boolean(skuHint || mpnHint || barcodeHint);
}

function strongEvidence(row, variant, candidate) {
  const evidence = [];
  const variantBarcode = validGtin(variant.barcode);
  const gtins = (candidate.gtins || []).map(validGtin).filter(Boolean);
  if (variantBarcode && gtins.includes(variantBarcode)) {
    evidence.push({ kind: "GTIN", value: variantBarcode });
  }
  if (row.shopifyVariantIdHint === variant.shopifyVariantId && explicitCandidateMatch(row, candidate)) {
    if (row.supplierSkuHint) evidence.push({ kind: "SUPPLIER_SKU_MAPPING", value: row.supplierSkuHint });
    if (row.mpnHint) evidence.push({ kind: "SUPPLIER_MPN_MAPPING", value: row.mpnHint });
    if (row.barcodeHint) evidence.push({ kind: "BARCODE_MAPPING", value: row.barcodeHint });
  }
  return evidence;
}

function titleOverlap(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

export function suggestImportMatch(row, variants, metadata) {
  const candidates = (metadata.productCandidates || []).flatMap(candidateIdentities);
  const strong = [];
  for (const variant of variants) {
    if (row.shopifyVariantIdHint && row.shopifyVariantIdHint !== variant.shopifyVariantId) continue;
    for (const candidate of candidates) {
      const evidence = strongEvidence(row, variant, candidate);
      if (!evidence.length) continue;
      const conflict = optionConflict(variant, candidate);
      strong.push({ variant, candidate, evidence, conflict });
    }
  }
  const qualified = strong.filter((item) => !item.conflict);
  if (qualified.length === 1) {
    const match = qualified[0];
    return {
      status: "READY_FOR_REVIEW",
      suggestedVariantId: match.variant.shopifyVariantId,
      suggestedCandidate: match.candidate,
      matchReason: match.evidence.map((item) => item.kind).join(" + "),
      matchEvidence: match.evidence,
    };
  }
  if (qualified.length > 1 || strong.some((item) => item.conflict)) {
    return {
      status: "NEEDS_REVIEW",
      suggestedVariantId: qualified.length === 1 ? qualified[0].variant.shopifyVariantId : row.shopifyVariantIdHint || null,
      suggestedCandidate: qualified.length === 1 ? qualified[0].candidate : null,
      matchReason: qualified.length > 1 ? "MULTIPLE_STRONG_MATCHES" : strong.find((item) => item.conflict)?.conflict,
      matchEvidence: qualified.flatMap((item) => item.evidence),
    };
  }

  const pageTitle = metadata.title || candidates[0]?.title || "";
  const fuzzy = [];
  for (const variant of variants) {
    if (row.shopifyVariantIdHint && row.shopifyVariantIdHint !== variant.shopifyVariantId) continue;
    for (const candidate of candidates.length ? candidates : [{ title: pageTitle, displayName: pageTitle }]) {
      const score = titleOverlap(variant.parentTitle + " " + (variant.variantTitle || ""), candidate.displayName || candidate.title);
      if (score > 0 && !optionConflict(variant, candidate)) fuzzy.push({ variant, candidate, score });
    }
  }
  fuzzy.sort((a, b) => b.score - a.score);
  if (fuzzy.length && (fuzzy.length === 1 || fuzzy[0].score > fuzzy[1].score)) {
    return {
      status: "NEEDS_REVIEW",
      suggestedVariantId: fuzzy[0].variant.shopifyVariantId,
      suggestedCandidate: fuzzy[0].candidate,
      matchReason: "TITLE_SIMILARITY_ONLY",
      matchEvidence: [{ kind: "TITLE_TOKEN_OVERLAP", value: fuzzy[0].score }],
    };
  }
  return {
    status: "NO_MATCH",
    suggestedVariantId: row.shopifyVariantIdHint || null,
    suggestedCandidate: null,
    matchReason: candidates.length ? "NO_STRONG_OR_UNIQUE_TITLE_MATCH" : "NO_PRODUCT_CANDIDATE",
    matchEvidence: [],
  };
}

export { validGtin };
