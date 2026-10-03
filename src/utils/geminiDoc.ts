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

/**
 * Models to fall back through, in order, when the one configured cannot serve
 * the request.
 *
 * This matters more than it looks: the free tier counts its daily quota *per
 * model* ("GenerateRequestsPerDayPerProjectPerModel"), and a premium model
 * like gemini-3.6-flash allows as few as 20 documents a day. Falling through
 * doesn't just dodge a busy server - it draws on a fresh allowance, which is
 * the difference between the feature working all day and dying by mid-morning.
 *
 * "lite" models lead deliberately. Measured against a known invoice they read
 * every field correctly in ~1.5s, while the full flash models were returning
 * 503s and, when they did answer, took several times longer - being cheaper to
 * serve makes them both less contended and more generously rationed. The full
 * model trails the list for the harder scans the small ones might fumble.
 *
 * Every entry here was verified to exist and answer; Google retires model
 * names without much ceremony (both gemini-2.0-flash and gemini-2.5-flash died
 * during this feature's short life), which is why the "-latest" aliases sit at
 * the front - they follow Google's renames on their own.
 */
const FALLBACK_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-flash-latest",
];

/** Whatever GEMINI_MODEL asks for is tried first, then the rest as backups. */
function modelChain(): string[] {
  return Array.from(new Set([env.gemini.model, ...FALLBACK_MODELS].filter(Boolean)));
}

/** Google briefly rejecting a request under load - worth one retry on the same model. */
function isOverloaded(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b503\b|overloaded|unavailable/i.test(message);
}

/**
 * The daily free allowance for that model is gone. Retrying it is pointless -
 * the quota resets at midnight US Pacific, not in a few seconds - so the only
 * useful move is to try a different model.
 */
function isQuotaExhausted(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b429\b|quota|rate.?limit|resource.?exhausted/i.test(message);
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
 * A single model can stall for minutes under load, so each attempt is capped
 * rather than left to hang the user's upload.
 */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Tries each model in the chain until one answers.
 *
 * A busy model gets one quick retry - 503s are often momentary. A model whose
 * daily quota is gone gets none, because waiting cannot bring it back; we move
 * straight to the next model's separate allowance. Only when every model has
 * refused do we surface an error, and which error depends on why: "come back
 * in a minute" and "today's free quota is gone" call for very different
 * responses from whoever is standing at the form.
 */
async function generateWithFallback(
  parts: Parameters<ReturnType<GoogleGenerativeAI["getGenerativeModel"]>["generateContent"]>[0]
): Promise<string> {
  const client = geminiClient();
  const models = modelChain();

  let lastError: unknown;
  let sawQuotaExhausted = false;

  for (const name of models) {
    const model = client.getGenerativeModel(
      { model: name },
      { timeout: REQUEST_TIMEOUT_MS }
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await model.generateContent(parts);
        return result.response.text();
      } catch (err) {
        lastError = err;

        if (isQuotaExhausted(err)) {
          // Out of allowance on this model for today - next model, no waiting.
          sawQuotaExhausted = true;
          break;
        }
        if (isOverloaded(err) && attempt === 0) {
          await sleep(1500);
          continue;
        }
        break;
      }
    }
  }

  if (sawQuotaExhausted) {
    throw new ApiError(
      429,
      "Today's free Gemini quota is used up. It resets at midnight US Pacific - " +
        "until then, enter the details by hand, or enable billing on the Google " +
        "project to lift the daily cap."
    );
  }
  if (isOverloaded(lastError)) {
    throw new ApiError(
      503,
      "Google's AI service is at capacity right now - please try again in a minute."
    );
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ApiError(502, `Could not read the PDF: ${message}`);
}

/** Hands a PDF or photo to Gemini with `prompt`, and parses the JSON it replies with. */
export async function extractJsonFromDocument(
  file: Buffer,
  mimeType: string,
  prompt: string
): Promise<unknown> {
  const text = await generateWithFallback([
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
