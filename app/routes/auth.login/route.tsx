import { AppProvider } from "@shopify/shopify-app-react-router/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!new URL(request.url).searchParams.has("shop")) return redirect("/");
  return login(request);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return login(request);
};

export default function Auth() {
  return (
    <AppProvider embedded={false}>
      <s-page>
        <s-section heading="Open SupplierSignal from Shopify Admin">
          <s-paragraph>Use your installed app in Shopify Admin to continue.</s-paragraph>
          <s-link href="/">Return to SupplierSignal</s-link>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
