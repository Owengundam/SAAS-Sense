type AdminContext = { graphql: (query: string, options?: { signal?: AbortSignal }) => Promise<Response> };
type ConnectionStatus = "configured" | "not_configured" | "connected_no_plan" | "active_plan" | "error";
type ConnectionResult = { status: ConnectionStatus; message: string };
type Dependencies = {
  authenticateAdmin: (request: Request) => Promise<{ admin: AdminContext }>;
  fetchShopSubscription: (admin: AdminContext, options: { fresh: boolean; signal: AbortSignal }) => Promise<unknown>;
};

// Only configuration presence leaves the server. Never return environment
// values, raw API payloads, exception messages, or credentials to the browser.
export function billingConnectionConfiguration(): ConnectionResult {
  const configured = ["SHOPIFY_PARTNER_ORG_ID", "SHOPIFY_PARTNER_API_ACCESS_TOKEN", "SHOPIFY_APP_GID"]
    .every((key) => Boolean(process.env[key]?.trim()));
  return configured
    ? { status: "configured", message: "Configured. Connection has not been checked." }
    : { status: "not_configured", message: "Billing connection is not configured. Contact support." };
}

export function createBillingConnectionAction({ authenticateAdmin, fetchShopSubscription }: Dependencies) {
  return async ({ request }: { request: Request }) => {
    // Authenticate the action itself; a parent loader is not an auth boundary.
    // Keep auth failures outside the catch so Shopify can finish login normally.
    const { admin } = await authenticateAdmin(request);
    const respond = (result: ConnectionResult, status = 200) => Response.json(result, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
    if (request.method !== "POST") {
      return respond({ status: "error", message: "Use the billing connection check button." }, 405);
    }
    try {
      const form = await request.formData();
      if (form.get("intent") !== "check-billing-connection") {
        return respond({ status: "error", message: "Unknown settings action." }, 400);
      }
      const configuration = billingConnectionConfiguration();
      if (configuration.status === "not_configured") return respond(configuration);

      // Explicit, read-only check works even before pricing enforcement is on.
      // No request-supplied shop/app IDs are accepted. The existing reader gets
      // the shop ID from this authenticated Admin API and app ID from the server.
      const subscription = await fetchShopSubscription(admin, { fresh: true, signal: request.signal });
      return respond(subscription
        ? { status: "active_plan", message: "Connected. This store has an active Shopify plan." }
        : { status: "connected_no_plan", message: "Connected. This store has no active Shopify plan." });
    } catch {
      return respond({ status: "error", message: "Unable to verify the billing connection. Try again or contact support." });
    }
  };
}
