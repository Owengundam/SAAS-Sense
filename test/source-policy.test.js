import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPublicHostnameDns,
  isPrivateHostname,
  validatePublicResourceUrl,
  validateSupplierRedirect,
  validateSupplierUrl,
} from "../src/source-policy.js";

const supported = ["supplier.example", "www.supplier.example"];

test("supplier URLs must be HTTPS and on the declared domain list", () => {
  assert.equal(validateSupplierUrl("https://supplier.example/product/1", supported).hostname, "supplier.example");
  assert.throws(() => validateSupplierUrl("http://supplier.example/product/1", supported), /HTTPS_REQUIRED/);
  assert.throws(() => validateSupplierUrl("https://other.example/product/1", supported), /UNSUPPORTED_SUPPLIER_DOMAIN/);
  assert.throws(() => validateSupplierUrl("https://cdn.supplier.example/product/1", supported), /UNSUPPORTED_SUPPLIER_DOMAIN/);
});

test("credentials, nonstandard ports, and private targets are rejected", () => {
  assert.throws(() => validateSupplierUrl("https://user:pass@supplier.example/product", supported), /SOURCE_URL_CREDENTIALS_FORBIDDEN/);
  assert.throws(() => validateSupplierUrl("https://supplier.example:8443/product", supported), /UNSUPPORTED_SUPPLIER_PORT/);
  assert.equal(isPrivateHostname("127.0.0.1"), true);
  assert.equal(isPrivateHostname("10.2.3.4"), true);
  assert.equal(isPrivateHostname("::1"), true);
  assert.throws(() => validateSupplierUrl("https://localhost/product", ["localhost"]), /PRIVATE_SOURCE_FORBIDDEN/);
});

test("redirects must remain on an explicitly declared supported hostname", () => {
  assert.equal(
    validateSupplierRedirect("https://supplier.example/a", "https://www.supplier.example/a", supported).hostname,
    "www.supplier.example",
  );
  assert.throws(() => validateSupplierRedirect(
    "https://supplier.example/a",
    "https://cdn.supplier.example/a",
    supported,
  ), /UNAPPROVED_SUPPLIER_REDIRECT/);
});

test("browser subresources reject private networks and unsafe protocols", () => {
  assert.equal(validatePublicResourceUrl("https://cdn.example/assets/app.js").hostname, "cdn.example");
  assert.equal(validatePublicResourceUrl("data:text/plain,ok").protocol, "data:");
  assert.throws(() => validatePublicResourceUrl("http://cdn.example/app.js"), /UNSAFE_RESOURCE_PROTOCOL/);
  assert.throws(() => validatePublicResourceUrl("https://127.0.0.1/secrets"), /PRIVATE_RESOURCE_FORBIDDEN/);
});

test("DNS validation rejects public hostnames that resolve to private addresses", async () => {
  await assert.doesNotReject(() => assertPublicHostnameDns(
    "supplier.example",
    async () => [{ address: "8.8.8.8", family: 4 }],
  ));
  await assert.rejects(() => assertPublicHostnameDns(
    "supplier.example",
    async () => [{ address: "10.0.0.7", family: 4 }],
  ), /PRIVATE_DNS_TARGET_FORBIDDEN/);
  await assert.rejects(() => assertPublicHostnameDns(
    "supplier.example",
    async () => [{ address: "::1", family: 6 }],
  ), /PRIVATE_DNS_TARGET_FORBIDDEN/);
});
