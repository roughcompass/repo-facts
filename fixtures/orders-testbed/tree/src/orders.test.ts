import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { expect, it } from "vitest";
import { listOrders } from "./orders";

const server = setupServer(http.get("https://orders.example.test/orders", () => HttpResponse.json([])));

it("lists orders", async () => {
  server.listen();
  expect(await listOrders()).toEqual([]);
  server.close();
});
