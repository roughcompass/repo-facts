import createClient from "openapi-fetch";

const client = createClient({ baseUrl: import.meta.env.VITE_BILLING_URL, headers: { Authorization: `Bearer ${import.meta.env.VITE_BILLING_TOKEN}` } });

export function billing(route: string) {
  return client.GET(route);
}
