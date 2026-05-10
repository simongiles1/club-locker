import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createAiAgent } from "./aiAgent.js";

describe("createAiAgent", () => {
  it("uses mock agent and classifies signup-like emails", async () => {
    const config = { ...loadConfig(), AI_AGENT: "mock" as const };
    const agent = createAiAgent(config);
    const result = await agent.classifyEmail({
      fromEmail: "pgartenburg+test@gmail.com",
      toEmail: "cambridgeclubchamps@gmail.com",
      subject: "Please sign me up",
      body: "Hi - can you sign me up for the A draw?",
      context: {
        activeChampionships: [],
        openMatches: [],
      },
    });
    expect(result.kind).toBe("signup");
    expect(result.confidence).toBe("medium");
    expect(result.model).toBe("mock");
  });
});
