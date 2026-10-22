// Follow-up questions about cards already shown → text only (no repeated cards).
import assert from 'node:assert/strict';
import { isFollowUpQuestion } from '../src/backend/agent/followUp';

const text = ['which is the best rated one?', 'is it open now?', 'cheapest one?', 'how far is it?', 'what time does it close?'];
const cards = ['ok show me its menu', 'what about pizza?', 'any veg biryani?', 'is there anything cheaper?', 'book tomorrow 8 pm for 2', 'mutton biryani'];
for (const m of text) assert.equal(isFollowUpQuestion(m, true), true, m);
for (const m of cards) assert.equal(isFollowUpQuestion(m, true), false, m);
assert.equal(isFollowUpQuestion('is it open now?', false), false, 'first message always gets cards');
console.log(`follow-up rule: ${text.length + cards.length + 1} passed`);
