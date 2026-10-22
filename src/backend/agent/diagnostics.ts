// Error classification for the chat route. Turns provider-chain and Swiggy MCP
// failures into a short, actionable Markdown message for the chat bubble.

export interface FormattedError {
  category: "SWIGGY_AUTH" | "RATE_LIMITED" | "PROVIDERS_UNAVAILABLE" | "NO_PROVIDER_KEYS" | "UNKNOWN";
  statusCode: number;
  title: string;
  cause: string;
  solution: string;
  raw?: string;
}

export function classifyProviderError(status: number, rawMessage: string): FormattedError {
  const msg = (rawMessage || "").toLowerCase();

  if (
    msg.includes("swiggy token") ||
    msg.includes("jwt has expired") ||
    msg.includes("invalid_token") ||
    msg.includes("authentication required") ||
    msg.includes("-32001")
  ) {
    return {
      category: "SWIGGY_AUTH",
      statusCode: 401,
      title: "🔒 Please log in to Swiggy",
      cause: "Your Swiggy session has expired or you're not signed in yet (sessions last about 5 days).",
      solution: "Tap **Log in** (top right) and finish the phone + OTP step. Your chat stays as it is.",
      raw: rawMessage,
    };
  }

  if (msg.includes("no llm provider keys")) {
    return {
      category: "NO_PROVIDER_KEYS",
      statusCode: 500,
      title: "⚙️ No AI provider configured",
      cause: "None of ANTHROPIC_API_KEY, GROQ_API_KEY(_2) or GEMINI_API_KEY(_2) is set on the server.",
      solution: "Add at least one key to `.env.local` (or the hosting provider's environment) and restart.",
      raw: rawMessage,
    };
  }

  if (status === 429 || msg.includes("rate limit") || msg.includes("resource_exhausted")) {
    return {
      category: "RATE_LIMITED",
      statusCode: 429,
      title: "⏳ Busy right now",
      cause: "Every AI model in the fallback chain is rate-limited at the moment.",
      solution: "Wait a few seconds and send your message again.",
      raw: rawMessage,
    };
  }

  if (status >= 500 || msg.includes("timeout") || msg.includes("timed out") || msg.includes("fetch failed") || msg.includes("high demand")) {
    return {
      category: "PROVIDERS_UNAVAILABLE",
      statusCode: status || 503,
      title: "🌐 AI models are unavailable",
      cause: "Claude, Groq and Gemini all failed or timed out for this message.",
      solution: "Please try again in a moment.",
      raw: rawMessage,
    };
  }

  return {
    category: "UNKNOWN",
    statusCode: status || 500,
    title: "⚠️ Something went wrong",
    cause: rawMessage || "An unexpected error occurred while handling your message.",
    solution: "Please try again. If it keeps happening, start a new chat.",
    raw: rawMessage,
  };
}

/** Short Markdown for the chat error bubble. */
export function formatErrorMarkdown(err: FormattedError): string {
  return `### ${err.title}\n\n${err.cause}\n\n${err.solution}`;
}
