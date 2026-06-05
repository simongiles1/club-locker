import { describe, expect, it } from "vitest";
import { interpolateEmailTemplate } from "./emailTemplate.js";

describe("interpolateEmailTemplate", () => {
  it("clears known placeholders when the value is an empty string", () => {
    const out = interpolateEmailTemplate("Hello {{name}}!", { name: "" });
    expect(out).toBe("Hello !");
  });

  it("leaves unknown placeholders unchanged", () => {
    const out = interpolateEmailTemplate("Hello {{missing}}!", {});
    expect(out).toBe("Hello {{missing}}!");
  });
});
