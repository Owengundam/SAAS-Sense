import { isIP } from "node:net";

export const DEFAULT_SUPPORTED_DOMAINS = Object.freeze([
  "books.toscrape.com",
  "supplier.example",
  "supplier.test",
]);

function normalizeHost(value) {
  return String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function normalizeSupportedDomains(domains = DEFAULT_SUPPORTED_DOMAINS) {
  const values = Array.isArray(domains) ? domains : String(domains || "").split(",");
  return [...new Set(values.map(normalizeHost).filter(Boolean))];
}

function isPrivateIpv4(host) {
  const parts = host.split(".").map(Number);
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function isPrivateIpv6(host) {
  const normalized = normalizeHost(host);
  if (normalized === "::" || normalized === "::1") return true;
  if (/^(fc|fd)/i.test(normalized) || /^fe[89ab]/i.test(normalized)) return true;
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
}

export function isPrivateHostname(hostname) {
  const host = normalizeHost(hostname);
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal")) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) return isPrivateIpv6(host);
  return false;
}

export function isSupportedHostname(hostname, supportedDomains = DEFAULT_SUPPORTED_DOMAINS) {
  const host = normalizeHost(hostname);
  return normalizeSupportedDomains(supportedDomains).includes(host);
}

export function validateSupplierUrl(value, supportedDomains = DEFAULT_SUPPORTED_DOMAINS) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_SOURCE_URL");
  }
  if (url.protocol !== "https:") throw new Error("HTTPS_REQUIRED");
  if (url.username || url.password) throw new Error("SOURCE_URL_CREDENTIALS_FORBIDDEN");
  if (url.port && url.port !== "443") throw new Error("UNSUPPORTED_SUPPLIER_PORT");
  if (isPrivateHostname(url.hostname)) throw new Error("PRIVATE_SOURCE_FORBIDDEN");
  if (!isSupportedHostname(url.hostname, supportedDomains)) throw new Error("UNSUPPORTED_SUPPLIER_DOMAIN");
  url.hash = "";
  return url;
}

export function validateSupplierRedirect(sourceUrl, resolvedUrl, supportedDomains = DEFAULT_SUPPORTED_DOMAINS) {
  const source = validateSupplierUrl(sourceUrl, supportedDomains);
  let resolved;
  try {
    resolved = validateSupplierUrl(resolvedUrl || sourceUrl, supportedDomains);
  } catch (error) {
    if (error instanceof Error && error.message === "UNSUPPORTED_SUPPLIER_DOMAIN") {
      throw new Error("UNAPPROVED_SUPPLIER_REDIRECT");
    }
    throw error;
  }
  const declared = normalizeSupportedDomains(supportedDomains);
  if (source.hostname !== resolved.hostname && !declared.includes(normalizeHost(resolved.hostname))) {
    throw new Error("UNAPPROVED_SUPPLIER_REDIRECT");
  }
  return resolved;
}
