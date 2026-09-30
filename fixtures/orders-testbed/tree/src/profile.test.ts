import { expect, it, vi } from "vitest";
import profile from "./__fixtures__/profile.json";
import { loadProfile } from "./profile";

it("loads the profile", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(profile))));
  expect(await loadProfile()).toEqual(profile);
});
