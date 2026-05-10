import type { AppConfig } from "../config.js";

export type LangfuseCaptureInput = {
  name: string;
  model: string;
  prompt: string;
  completion: string;
  inputTokens?: number;
  outputTokens?: number;
  metadata?: Record<string, unknown>;
};

type MaybeLangfuseClient = {
  trace?: (payload: Record<string, unknown>) => unknown;
  generation?: (payload: Record<string, unknown>) => unknown;
  flushAsync?: () => Promise<void>;
};

let singletonClient: MaybeLangfuseClient | null | undefined;

async function getLangfuseClient(
  config: AppConfig,
): Promise<MaybeLangfuseClient | null> {
  if (
    !config.LANGFUSE_HOST ||
    !config.LANGFUSE_PUBLIC_KEY ||
    !config.LANGFUSE_SECRET_KEY
  ) {
    return null;
  }
  if (singletonClient !== undefined) {
    return singletonClient;
  }
  try {
    const mod = (await import("langfuse")) as Record<string, unknown>;
    const LangfuseCtor = mod.Langfuse as
      | (new (args: Record<string, unknown>) => MaybeLangfuseClient)
      | undefined;
    if (!LangfuseCtor) {
      singletonClient = null;
      return null;
    }
    singletonClient = new LangfuseCtor({
      baseUrl: config.LANGFUSE_HOST,
      publicKey: config.LANGFUSE_PUBLIC_KEY,
      secretKey: config.LANGFUSE_SECRET_KEY,
    });
    return singletonClient;
  } catch (err) {
    console.warn("[langfuse] disabled:", err);
    singletonClient = null;
    return null;
  }
}

export async function captureLangfuseTrace(
  config: AppConfig,
  input: LangfuseCaptureInput,
): Promise<string | null> {
  const client = await getLangfuseClient(config);
  if (!client) return null;
  const traceId = crypto.randomUUID();
  const startTime = new Date();
  try {
    const traceMaybe = client.trace?.({
      id: traceId,
      name: input.name,
      input: {
        executionId: input.metadata?.executionId,
        stepName: input.metadata?.stepName,
        promptLength: input.prompt.length,
      },
      output: {
        completionLength: input.completion.length,
        completionPreview: input.completion.slice(0, 2000),
      },
      metadata: input.metadata ?? {},
      timestamp: startTime,
    }) as
      | {
          generation?: (payload: Record<string, unknown>) => {
            end?: (b: Record<string, unknown>) => unknown;
          };
        }
      | void;
    const generationPayload = {
      name: input.name,
      model: input.model,
      input: input.prompt,
      output: input.completion,
      metadata: input.metadata ?? {},
      startTime,
      ...(input.inputTokens != null || input.outputTokens != null
        ? {
            usage: {
              ...(input.inputTokens != null ? { input: input.inputTokens } : {}),
              ...(input.outputTokens != null ? { output: input.outputTokens } : {}),
            },
          }
        : {}),
    };
    let gen: { end?: (b: Record<string, unknown>) => unknown } | void;
    if (traceMaybe && typeof traceMaybe.generation === "function") {
      gen = traceMaybe.generation(generationPayload);
    } else {
      gen = client.generation?.({
        ...generationPayload,
        traceId,
      }) as { end?: (b: Record<string, unknown>) => unknown } | void;
    }
    if (gen && typeof gen.end === "function") {
      gen.end({
        output: input.completion,
        ...(input.inputTokens != null || input.outputTokens != null
          ? {
              usage: {
                ...(input.inputTokens != null ? { input: input.inputTokens } : {}),
                ...(input.outputTokens != null ? { output: input.outputTokens } : {}),
              },
            }
          : {}),
      });
    }
    await client.flushAsync?.();
    return traceId;
  } catch (err) {
    console.warn("[langfuse] trace capture failed:", err);
    return null;
  }
}
