import { createOpenAI } from "@ai-sdk/openai";

type RunIdFetch = {
  fetch: typeof fetch;
  getRunId: () => string | undefined;
};

export function createLovableAiGatewayRunIdFetch(initialRunId?: string): RunIdFetch {
  let runId = initialRunId;

  return {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (runId) headers.set("X-Lovable-AIG-Run-ID", runId);
      const response = await fetch(input, { ...init, headers });
      runId = response.headers.get("X-Lovable-AIG-Run-ID") ?? runId;
      return response;
    },
    getRunId: () => runId,
  };
}

export function createLovableGateway(key: string, request: Request) {
  const runIdFetch = createLovableAiGatewayRunIdFetch(
    request.headers.get("X-Lovable-AIG-Run-ID") ?? undefined,
  );
  const provider = createOpenAI({
    baseURL: "https://ai.gateway.lovable.dev/v1",
    apiKey: key,
    headers: {
      "Lovable-API-Key": key,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    fetch: runIdFetch.fetch,
  });

  return { model: provider.responses("openai/gpt-5.6-sol"), runIdFetch };
}

export function withLovableAiGatewayRunIdHeader(response: Response, runIdFetch: RunIdFetch) {
  const headers = new Headers(response.headers);
  const runId = runIdFetch.getRunId();
  if (runId) headers.set("X-Lovable-AIG-Run-ID", runId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}