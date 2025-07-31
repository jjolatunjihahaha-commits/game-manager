/**
 * Game Manager – core bootstrap
 * Registers chat-event listeners and exposes helper APIs for the drawer UI.
 */
import { optimisePrompt } from './optimizer.js';
import { trackEvent } from './storyTracker.js';

// Internal extension-state (kept tiny; heavy stuff lives in chatMetadata / card fields)
const state = {
  pendingCardUpdate: null,
  pendingLoreUpdate: null,
  firstMessageDraft: null,
  optimiserFailures: 0,
};

// ─── Chat-event hooks ─────────────────────────────────────────────────────────

ST.on('CHAT_MESSAGE_ADDED', (msg, chat) => {
  trackEvent(msg, chat, state);
});

ST.on('GENERATE_INTERCEPT', async (ctx) => {
  try {
    ctx.systemPrompt = await optimisePrompt(ctx.systemPrompt, { tokenCap: 3500 });
  } catch (err) {
    console.error('[GameManager] optimiser failed', err);
    state.optimiserFailures += 1;
    if (state.optimiserFailures === 2) return ctx; // send raw after 1 retry
    throw err; // first failure triggers ST retry
  }
  return ctx;
});

// Expose minimal bridge for UI → logic
export function getPendingUpdates() {
  return {
    card: state.pendingCardUpdate,
    lore: state.pendingLoreUpdate,
    firstMessage: state.firstMessageDraft,
    failures: state.optimiserFailures,
  };
}

export function applyCardUpdate(text) {
  // TODO: writeExtensionField on active character card
  state.pendingCardUpdate = null;
}

export function applyLoreUpdate(entryId, text) {
  // TODO: Lorebook API call
  state.pendingLoreUpdate = null;
}

export async function generateFirstMessage() {
  // TODO: call main LLM via generateQuietPrompt
  state.firstMessageDraft = '...generated text...';
}
