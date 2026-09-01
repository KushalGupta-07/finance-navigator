import { createFileRoute } from "@tanstack/react-router";
import { convertToModelMessages, streamText, type UIMessage } from "ai";

import {
  createLovableGateway,
  withLovableAiGatewayRunIdHeader,
} from "@/lib/ai-gateway.server";

type ChatRequestBody = {
  messages?: unknown;
  controllerContext?: unknown;
};

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: ChatRequestBody;
        try {
          body = (await request.json()) as ChatRequestBody;
        } catch {
          return new Response("Invalid chat request", { status: 400 });
        }
        if (!Array.isArray(body.messages)) {
          return new Response("Messages are required", { status: 400 });
        }

        const key = process.env["LOVABLE_API_KEY"];
        if (!key) {
          return new Response(
            "Lovable AI is not configured for this local server. Add LOVABLE_API_KEY to .env.local and restart the dev server.",
            { status: 503 },
          );
        }

        const controllerContext =
          body.controllerContext && typeof body.controllerContext === "object"
            ? JSON.stringify(body.controllerContext)
            : "No live controller snapshot was provided.";
        const { model, runIdFetch } = createLovableGateway(key, request);
        const result = streamText({
          model,
          system: `You are the Q&A agent for an AI finance controller. Answer questions about the current synthetic reconciliation batch and cash forecast using the live snapshot below. Be concise, precise, and transparent. Use USD unless the user asks otherwise. Never invent a transaction, match, exception, or forecast detail. If the snapshot does not contain enough information, say so and point the user to the relevant dashboard view.

Live controller snapshot:
${controllerContext}`,
          messages: await convertToModelMessages(body.messages as UIMessage[]),
          abortSignal: request.signal,
          providerOptions: {
            openai: {
              forceReasoning: true,
              reasoningEffort: "medium",
              reasoningSummary: "auto",
              store: false,
              include: ["reasoning.encrypted_content"],
            },
          },
        });

        return withLovableAiGatewayRunIdHeader(
          result.toUIMessageStreamResponse({
            originalMessages: body.messages as UIMessage[],
            sendReasoning: true,
          }),
          runIdFetch,
        );
      },
    },
  },
});