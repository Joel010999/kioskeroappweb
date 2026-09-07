import { describe, expect, it } from "vitest";
import { activityActorLabel } from "./activity";

describe("activity actor labels", () => {
  it("shows the server-resolved actor name when available", () => {
    expect(activityActorLabel({ actor_name: "Development PV1", actor_email: "pv1@development.local" })).toBe("Development PV1");
  });

  it("keeps historical events visible when no actor was recorded", () => {
    expect(activityActorLabel({ actor_name: null, actor_email: null })).toBe("Actor no registrado");
  });
});
