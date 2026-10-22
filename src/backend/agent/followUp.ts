// Is this message a follow-up QUESTION about results already in the
// conversation ("which is best rated?", "is it open now?")? Then the chat route
// answers in text and draws no new cards. Anything that asks to SEE something —
// a new search, a menu, more / cheaper / other options, ordering or booking —
// still gets cards.

const SHOW_INTENT =
  /\b(show|find|search|list|menu|more|other|another|options?|alternatives?|instead|else|any|anything|cheaper|veg|what about|how about|near|order|add|buy|book|reserve|get me|suggest|recommend|need|want|looking for|craving|plan|ideas?)\b/i;
const QUESTION = /\?\s*$|^(which|what|is|are|was|does|do|did|how|when|where|who|can|could|should|will|would|has|have)\b/i;

export function isFollowUpQuestion(message: string, hasHistory: boolean): boolean {
  const m = message.trim();
  return hasHistory && m.length > 0 && m.length < 160 && QUESTION.test(m) && !SHOW_INTENT.test(m);
}
