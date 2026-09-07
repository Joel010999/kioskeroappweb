import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "./proxy";

describe("navigation proxy", () => {
  it.each([
    "/dashboard",
    "/replenishment",
    "/replenishment/review",
    "/orders",
    "/orders/warehouse",
    "/supply-rules",
  ])("redirects %s to login when the session cookie is absent", (path) => {
    const response = proxy(new NextRequest(`https://monica.local${path}`));
    expect(response.headers.get("location")).toBe("https://monica.local/login");
  });

  it("lets the request reach server-side authorization when a session cookie exists", () => {
    const response = proxy(
      new NextRequest("https://monica.local/dashboard", {
        headers: { cookie: "monica_session=session-value" },
      }),
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps the public login route available", () => {
    const response = proxy(new NextRequest("https://monica.local/login"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
