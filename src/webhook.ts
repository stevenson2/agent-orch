import type { OrchEvent } from "./types.js";

export async function deliverWebhook(
  url: string | undefined,
  event: OrchEvent,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orch-event": event.type,
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`webhook responded ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
