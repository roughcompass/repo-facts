import { describe, expect, it } from "vitest";
import { redactCredentials } from "../src/redaction.js";

describe("credential redaction", () => {
  it("redacts credentials from URLs in specifiers and commands", () => {
    expect(redactCredentials("git+ssh://git:token@host.example.test/a.git")).toBe("git+ssh://[redacted]@host.example.test/a.git");
    expect(redactCredentials("curl https://user@host.example.test/x && echo ok")).toBe("curl https://[redacted]@host.example.test/x && echo ok");
    expect(redactCredentials("github:acme/repo#main")).toBe("github:acme/repo#main");
  });

  it("redacts every URL in a longer command", () => {
    expect(redactCredentials("npm i https://a:b@one.example.test/x.tgz https://c@two.example.test/y.tgz")).toBe("npm i https://[redacted]@one.example.test/x.tgz https://[redacted]@two.example.test/y.tgz");
  });
});
