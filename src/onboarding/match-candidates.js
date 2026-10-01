function clean(value) {
  return String(value ?? "").trim();
}

function normalizedGtin(value) {
  const digits = clean(value).replace(/[^0-9]/g, "");
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

function meaningfulOptions(variant) {
  return (variant?.selectedOptions || [])
    .map((option) => ({ name: clean(option.name), value: clean(option.value) }))
    .filter((option) => option.value && option.value.toLowerCase() !== "default title");
}

export function optionCompatibility(variant, candidate, _row, pageText = "") {
  const options = meaningfulOptions(variant);
  if (!options.length) return { compatible: true, reasons: [] };

  // Only supplier-observed evidence may establish variant compatibility.
  // row.optionsHint is copied from the expected Shopify variant during discovery,
  // so using it here would let expectations confirm themselves.
  const structured = new Set((candidate?.optionValues || []).map((value) => clean(value).toLowerCase()));
  const text = clean(pageText).toLowerCase();
  const missing = [];
  for (const option of options) {
    const value = option.value.toLowerCase();
    const structuredMatch = structured.has(value);
    const textMatch = value.length >= 3 && text.includes(value);
    if (structured.size) {
      if (!structuredMatch) missing.push(`${option.name}: ${option.value}`);
      continue;
    }
    if (!textMatch) missing.push(`${option.name}: ${option.value}`);
  }
  return {
    compatible: missing.length === 0,
    reasons: missing.map((value) => `Variant option not verified on supplier page: ${value}`),
  };
}

function exactCandidateMatches(metadata, value, fields) {
  const needle = clean(value);
  if (!needle) return [];
  return metadata.candidates.filter((candidate) =>
    fields.some((field) => (candidate[field] || []).includes(needle)));
}

function candidatesWithGtin(metadata, barcode) {
  const needle = normalizedGtin(barcode);
  if (!needle) return [];
  return metadata.candidates.filter((candidate) => candidate.gtins.includes(needle));
}

function variantById(variants, id) {
  return variants.find((variant) => variant.shopifyVariantId === id) || null;
}

function variantsByBarcode(variants, barcode) {
  const needle = normalizedGtin(barcode);
  if (!needle) return [];
  return variants.filter((variant) => normalizedGtin(variant.barcode) === needle);
}

function primaryIdentifier(candidate, row) {
  for (const value of [row?.supplierSkuHint, row?.mpnHint, row?.barcodeHint]) {
    const needle = clean(value);
    if (needle && candidate.identityValues.includes(needle)) return needle;
    const code = normalizedGtin(needle);
    if (code && candidate.gtins.includes(code)) return code;
  }
  return candidate.skus[0] || candidate.mpns[0] || candidate.productIds[0] || candidate.gtins[0] || null;
}

function selectCandidate(row, metadata, targetVariant) {
  const explicitMatches = [
    ...exactCandidateMatches(metadata, row?.supplierSkuHint, ["skus", "mpns", "productIds"]),
    ...exactCandidateMatches(metadata, row?.mpnHint, ["mpns", "skus", "productIds"]),
    ...candidatesWithGtin(metadata, row?.barcodeHint),
  ];
  const uniqueExplicit = [...new Map(explicitMatches.map((candidate) => [candidate.key, candidate])).values()];
  if (uniqueExplicit.length === 1) return { candidate: uniqueExplicit[0], reason: "merchant_supplier_identifier" };
  if (uniqueExplicit.length > 1) return { ambiguous: true, reason: "multiple_supplier_candidates_match_hint" };

  if (targetVariant?.barcode) {
    const gtinMatches = candidatesWithGtin(metadata, targetVariant.barcode);
    if (gtinMatches.length === 1) return { candidate: gtinMatches[0], reason: "exact_gtin" };
    if (gtinMatches.length > 1) return { ambiguous: true, reason: "multiple_supplier_candidates_share_gtin" };
  }

  if (metadata.candidates.length === 1) return { candidate: metadata.candidates[0], reason: "single_supplier_candidate" };
  return { candidate: null, reason: "supplier_candidate_not_resolved" };
}

export function suggestImportMapping(row, variants, metadata, result = {}) {
  const hintedVariant = row?.shopifyVariantIdHint ? variantById(variants, row.shopifyVariantIdHint) : null;
  let targetVariant = hintedVariant;
  let variantReason = hintedVariant ? "merchant_variant_hint" : null;

  if (!targetVariant) {
    const supplierGtins = [...new Set(metadata.candidates.flatMap((candidate) => candidate.gtins))];
    const matchingVariants = [...new Map(
      supplierGtins.flatMap((code) => variantsByBarcode(variants, code))
        .map((variant) => [variant.shopifyVariantId, variant]),
    ).values()];
    if (matchingVariants.length === 1) {
      targetVariant = matchingVariants[0];
      variantReason = "exact_gtin";
    } else if (matchingVariants.length > 1) {
      return {
        status: "NEEDS_REVIEW",
        reason: "Multiple selected Shopify variants share supplier barcode evidence.",
        suggestedVariantId: null,
        candidateKey: null,
        matchTerms: [],
        primaryIdentifier: null,
      };
    }
  }

  const selected = selectCandidate(row, metadata, targetVariant);
  if (selected.ambiguous) {
    return {
      status: "NEEDS_REVIEW",
      reason: "Multiple supplier product candidates match the same identifier.",
      suggestedVariantId: targetVariant?.shopifyVariantId || null,
      candidateKey: null,
      matchTerms: [],
      primaryIdentifier: null,
    };
  }

  const candidate = selected.candidate;
  if (!candidate) {
    return {
      status: targetVariant ? "NEEDS_REVIEW" : "NO_MATCH",
      reason: targetVariant
        ? "Shopify variant is known, but the supplier product identity is not strong enough."
        : "No selected Shopify variant has a strong identifier match.",
      suggestedVariantId: targetVariant?.shopifyVariantId || null,
      candidateKey: null,
      matchTerms: [],
      primaryIdentifier: null,
    };
  }

  if (!targetVariant) {
    return {
      status: "NO_MATCH",
      reason: "Supplier metadata was extracted, but it does not strongly identify a selected Shopify variant.",
      suggestedVariantId: null,
      candidateKey: candidate.key,
      matchTerms: [],
      primaryIdentifier: primaryIdentifier(candidate, row),
    };
  }

  const targetBarcode = normalizedGtin(targetVariant.barcode);
  if (targetBarcode && candidate.gtins.length && !candidate.gtins.includes(targetBarcode)) {
    return {
      status: "NO_MATCH",
      reason: "Supplier barcode evidence conflicts with the selected Shopify variant.",
      suggestedVariantId: targetVariant.shopifyVariantId,
      candidateKey: candidate.key,
      matchTerms: [],
      primaryIdentifier: primaryIdentifier(candidate, row),
    };
  }

  const options = optionCompatibility(targetVariant, candidate, row, result?.text || metadata.pageTextSample || "");
  if (!options.compatible) {
    return {
      status: "NEEDS_REVIEW",
      reason: options.reasons.join(" "),
      suggestedVariantId: targetVariant.shopifyVariantId,
      candidateKey: candidate.key,
      matchTerms: [],
      primaryIdentifier: primaryIdentifier(candidate, row),
    };
  }

  const rowSupplierId = clean(row?.supplierSkuHint || row?.mpnHint);
  const merchantMappedSupplierId = rowSupplierId && candidate.identityValues.includes(rowSupplierId);
  const exactGtin = targetBarcode && candidate.gtins.includes(targetBarcode);
  const strong = Boolean(exactGtin || merchantMappedSupplierId);
  const identifier = primaryIdentifier(candidate, row);

  if (!strong || !identifier) {
    return {
      status: "NEEDS_REVIEW",
      reason: selected.reason === "single_supplier_candidate"
        ? "A supplier product was found, but title or single-candidate evidence alone is not enough for bulk approval."
        : "Supplier identity evidence is incomplete.",
      suggestedVariantId: targetVariant.shopifyVariantId,
      candidateKey: candidate.key,
      matchTerms: [],
      primaryIdentifier: identifier,
    };
  }

  const matchTerms = [...new Set([
    rowSupplierId,
    exactGtin ? targetBarcode : null,
    identifier,
  ].filter(Boolean))];

  return {
    status: "READY_FOR_REVIEW",
    reason: exactGtin
      ? `Exact barcode/GTIN match: ${targetBarcode}`
      : `Merchant supplier identifier confirmed on page: ${rowSupplierId}`,
    variantReason,
    suggestedVariantId: targetVariant.shopifyVariantId,
    candidateKey: candidate.key,
    matchTerms,
    primaryIdentifier: identifier,
  };
}
