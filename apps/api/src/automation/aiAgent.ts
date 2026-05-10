import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import type { AppConfig } from "../config.js";

export type InboundActionKind =
  | "signup"
  | "schedule_match"
  | "report_result"
  | "unknown";

export type InboundActionClassification = {
  kind: InboundActionKind;
  confidence: "low" | "medium" | "high";
  payload: Record<string, unknown>;
  replyDraft: string | null;
  rawModelOutput: string;
  prompt: string;
  completion: string;
  model: string;
};

export type ClassifyEmailInput = {
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  context: {
    activeChampionships: {
      id: string;
      name: string;
      divisionLabel: string;
    }[];
    senderPlayerId?: string | null;
    openMatches: {
      id: string;
      championshipId: string;
      round: number;
      dueDate?: string | null;
      championshipName?: string;
      /** Human-readable "Team A vs Team B" for disambiguation. */
      summary?: string;
    }[];
  };
};

export interface AiAgent {
  classifyEmail(input: ClassifyEmailInput): Promise<InboundActionClassification>;
}

const classificationSchema = z.object({
  kind: z.enum(["signup", "schedule_match", "report_result", "unknown"]),
  confidence: z.enum(["low", "medium", "high"]),
  payload: z.record(z.unknown()).default({}),
  replyDraft: z.string().nullable().optional(),
});

function unwrapJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const lines = trimmed.split("\n");
    const withoutFence = lines.slice(1, -1).join("\n");
    return withoutFence.trim();
  }
  return trimmed;
}

class MockAiAgent implements AiAgent {
  async classifyEmail(input: ClassifyEmailInput): Promise<InboundActionClassification> {
    const body = input.body.toLowerCase();
    let kind: InboundActionKind = "unknown";
    if (body.includes("sign") && body.includes("up")) kind = "signup";
    else if (body.includes("play") || body.includes("book")) kind = "schedule_match";
    else if (body.includes("won") || body.includes("score")) kind = "report_result";
    const replyDraft =
      kind === "unknown"
        ? "Thanks for your email. We could not confidently determine the request."
        : null;
    return {
      kind,
      confidence: kind === "unknown" ? "low" : "medium",
      payload: { body: input.body, subject: input.subject },
      replyDraft,
      rawModelOutput: JSON.stringify({ kind, replyDraft }),
      prompt: "[mock-agent]",
      completion: JSON.stringify({ kind, replyDraft }),
      model: "mock",
    };
  }
}

class GeminiAiAgent implements AiAgent {
  private readonly client: GoogleGenerativeAI;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async classifyEmail(input: ClassifyEmailInput): Promise<InboundActionClassification> {
    const prompt = [
      "You are an automation classifier for squash club championship emails.",
      "Classify the email and emit strict JSON only.",
      "Allowed kinds: signup, schedule_match, report_result, unknown.",
      "For signup include payload fields: championshipId (optional), playerIntent.",
      "For schedule_match include payload fields: matchId, scheduledAt (ISO 8601 datetime with correct year), notes (optional).",
      "If context.openMatches is non-empty and the email is about scheduling: set kind to schedule_match and set payload.matchId to exactly one id from openMatches (pick the row whose summary best matches the email). Never invent a matchId.",
      "If context.openMatches is empty or none of the summaries fit, use kind unknown with payload.reason explaining why, or schedule_match with matchId null only if scheduling intent is clear but no match could be chosen.",
      "For report_result include payload fields: matchId (from openMatches when possible), winnerHint, scoreText.",
      "For unknown include payload.reason.",
      "Also include confidence low|medium|high and optional replyDraft. For schedule_match, prefer a short replyDraft that confirms the proposed date and time to the sender (unless the email is purely internal).",
      "",
      "Context JSON:",
      JSON.stringify(input.context),
      "",
      "Inbound email:",
      JSON.stringify({
        fromEmail: input.fromEmail,
        toEmail: input.toEmail,
        subject: input.subject,
        body: input.body,
      }),
      "",
      "Return exactly this JSON shape:",
      '{"kind":"unknown","confidence":"low","payload":{},"replyDraft":null}',
    ].join("\n");

    const model = this.client.getGenerativeModel({ model: this.model });
    const res = await model.generateContent(prompt);
    const output = res.response.text();
    const jsonText = unwrapJson(output);
    let parsed: z.infer<typeof classificationSchema>;
    try {
      parsed = classificationSchema.parse(JSON.parse(jsonText));
    } catch {
      parsed = {
        kind: "unknown",
        confidence: "low",
        payload: { reason: "unparseable_model_response", raw: output },
        replyDraft: "Thanks for your email. Please rephrase your request.",
      };
    }

    return {
      kind: parsed.kind,
      confidence: parsed.confidence,
      payload: parsed.payload,
      replyDraft: parsed.replyDraft ?? null,
      rawModelOutput: output,
      prompt,
      completion: output,
      model: this.model,
    };
  }
}

export function createAiAgent(config: AppConfig): AiAgent {
  if (config.AI_AGENT === "gemini") {
    if (!config.GEMINI_API_KEY) {
      console.warn(
        "[automation] AI_AGENT=gemini but GEMINI_API_KEY missing; falling back to mock agent",
      );
      return new MockAiAgent();
    }
    return new GeminiAiAgent(config.GEMINI_API_KEY, config.GEMINI_MODEL);
  }
  return new MockAiAgent();
}
