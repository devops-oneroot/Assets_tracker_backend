import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env";
import { ApiError } from "../middleware/errorHandler";

/**
 * The shared plumbing behind every "Import from PDF or Photo": one Gemini
 * client, one retry policy, one way of turning a reply into JSON.
 *
 * Each caller brings its own prompt and its own coercion of the result - this
 * file knows nothing about purchase orders or assets, only how to hand a
 * document to Gemini and get parsed JSON back.
 */

/** What an "Import from PDF or Photo" upload may be: the document itself, or a picture of it. */
export const EXTRACTABLE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
]);

let client: GoogleGenerativeAI | null = null;

function geminiClient(): GoogleGenerativeAI {
  if (!env.gemini.apiKey) {
    throw new ApiError(
      500,
      "PDF import is not configured. Add GEMINI_API_KEY to backend/.env (get one at aistudio.google.com/apikey)."
    );
  }
  client ??= new GoogleGenerativeAI(env.gemini.apiKey);
  return client;
}

/** Google briefly rejecting a request under load - worth one retry, not a real failure. */
function isOverloaded(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b503\b|overloaded|unavailable/i.test(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stripCodeFence(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** "" unless it really is a YYYY-MM-DD date, which is what a date input expects. */
export const isoDate = (v: unknown): string => {
  const value = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
};

/**
 * Gemini's free tier gets a genuine "high demand" 503 now and then - not a
 * config problem, just the model being busy for a moment. Retried a couple of
 * times with backoff before giving up, so a passing spike doesn't force the
 * user to notice and click the upload again themselves.
 */
async function generateWithRetry(
  model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>,
  parts: Parameters<ReturnType<GoogleGenerativeAI["getGenerativeModel"]>["generateContent"]>[0]
): Promise<string> {
  const delaysMs = [2000, 5000];

  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await model.generateContent(parts);
      return result.response.text();
    } catch (err) {
      if (attempt < delaysMs.length && isOverloaded(err)) {
        await sleep(delaysMs[attempt]!);
        continue;
      }

      const message = err instanceof Error ? err.message : String(err);
      throw isOverloaded(err)
        ? new ApiError(
            503,
            "Google's AI service is at capacity right now - please try again in a minute."
          )
        : new ApiError(502, `Could not read the PDF: ${message}`);
    }
  }
}

/** Hands a PDF or photo to Gemini with `prompt`, and parses the JSON it replies with. */
export async function extractJsonFromDocument(
  file: Buffer,
  mimeType: string,
  prompt: string
): Promise<unknown> {
  const model = geminiClient().getGenerativeModel({ model: env.gemini.model });

  const text = await generateWithRetry(model, [
    { inlineData: { data: file.toString("base64"), mimeType } },
    prompt,
  ]);

  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    throw new ApiError(
      502,
      "Could not make sense of that PDF - try a clearer copy, or enter the details manually."
    );
  }
}
