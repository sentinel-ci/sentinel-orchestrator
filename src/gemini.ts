interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  error?: { message?: string };
}

/**
 * Calls the Gemini REST API directly (no SDK dependency) and returns the raw
 * text response. Shared by both LLM-driven agents — Alice (test generation)
 * and Bob (repair).
 */
export async function callGemini(model: string, apiKey: string, prompt: string): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    },
  );

  const body = (await response.json()) as GeminiResponse;

  if (!response.ok) {
    throw new Error(`Gemini API returned ${response.status}: ${body.error?.message ?? JSON.stringify(body)}`);
  }

  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Gemini API returned no text content: ${JSON.stringify(body)}`);
  }
  return text;
}

/**
 * Same as `callGemini`, but without forcing JSON output — for prompts that
 * ask for raw source code (fenced in markdown) rather than a JSON object.
 */
export async function callGeminiForText(model: string, apiKey: string, prompt: string): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    },
  );

  const body = (await response.json()) as GeminiResponse;

  if (!response.ok) {
    throw new Error(`Gemini API returned ${response.status}: ${body.error?.message ?? JSON.stringify(body)}`);
  }

  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Gemini API returned no text content: ${JSON.stringify(body)}`);
  }
  return text;
}

export function extractFencedCode(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:[a-z]*)\n([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : trimmed;
}
