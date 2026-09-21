import test from "node:test";
import assert from "node:assert/strict";
import {
  isPrivateHostname,
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
