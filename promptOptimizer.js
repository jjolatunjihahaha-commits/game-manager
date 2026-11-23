/**
 * Conservative, deterministic SillyTavern prompt cleanup.
 * Never edits the persisted chat array through GENERATE_INTERCEPT.
 * Operates only on final prompt-ready payloads and only deduplicates long,
 * byte-for-byte-equivalent prompt paragraphs in system/developer content.
 */
const MIN_PARAGRAPH_LENGTH = 72;
const TEXT_MIN_PARAGRAPH_LENGTH = 120;

function normalizeForExactMatch(value) {
    return String(value ?? '').replace(/\r\n/g, '\n').trim().replace(/[\t ]+/g, ' ');
}

function isProtectedParagraph(text, minLength = MIN_PARAGRAPH_LENGTH) {
    const value = String(text ?? '').trim();
    if (!value || value.length < minLength) return true;
    if (/```|~~~/.test(value)) return true;
    if (/<\/?[a-z][^>]*>/i.test(value)) return true;
    if (/^\s*[\[{]/.test(value) && /[}\]]\s*$/.test(value)) return true;
    if (/^(?:\s{0,3}#{1,6}\s|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/m.test(value)) return true;
    // Avoid dialogue, transcript, and example-message paragraphs.
    if (/^(?:user|assistant|system|developer|you|character|\w{1,30})\s*:/i.test(value)) return true;
    if ((value.match(/["“”]/g) || []).length >= 4) return true;
    return false;
}

function dedupeParagraphs(text, seen, minLength = MIN_PARAGRAPH_LENGTH) {
    const source = String(text ?? '');
    const paragraphs = source.split(/\n\s*\n/);
    const kept = [];
    let removedChars = 0;
    for (const paragraph of paragraphs) {
        const normalized = normalizeForExactMatch(paragraph);
        const protectedBlock = isProtectedParagraph(paragraph, minLength) || paragraph.trim().length < minLength;
        if (!protectedBlock && seen.has(normalized)) {
            removedChars += paragraph.length;
            continue;
        }
        if (!protectedBlock) seen.add(normalized);
        kept.push(paragraph);
    }
    return { text: kept.join('\n\n'), removedChars };
}

function isSystemMessage(message) {
    const role = String(message?.role ?? '').toLowerCase();
    return role === 'system' || role === 'developer' || message?.is_system === true;
}

export function optimizeChatCompletionPayload(eventData, mode = 'conservative') {
    if (!eventData || !Array.isArray(eventData.chat)) return { changed: false, removedChars: 0 };
    const seen = new Set();
    let removedChars = 0;
    let changed = false;

    for (const message of eventData.chat) {
        if (!isSystemMessage(message)) continue;
        const field = typeof message.content === 'string' ? 'content'
            : typeof message.mes === 'string' ? 'mes' : null;
        if (!field) continue; // multimodal/structured content is deliberately untouched
        const before = message[field];
        const minLength = mode === 'aggressive' ? 56 : mode === 'balanced' ? 64 : MIN_PARAGRAPH_LENGTH;
        const result = dedupeParagraphs(before, seen, minLength);
        if (result.text !== before) {
            message[field] = result.text;
            removedChars += result.removedChars;
            changed = true;
        }
    }
    return { changed, removedChars };
}

function looksLikeInstructionBlock(text, minLength = TEXT_MIN_PARAGRAPH_LENGTH) {
    const value = String(text ?? '').trim();
    if (value.length < minLength) return false;
    if (isProtectedParagraph(value, minLength)) return false;
    return /\b(you are|you must|you should|never|always|the character|in this scenario|roleplay|world setting|instructions?)\b/i.test(value);
}

export function optimizeTextCompletionPayload(eventData, mode = 'conservative') {
    if (!eventData || typeof eventData.prompt !== 'string' || eventData.dryRun) {
        return { changed: false, removedChars: 0 };
    }
    const paragraphs = eventData.prompt.split(/\n\s*\n/);
    const minLength = mode === 'aggressive' ? 100 : mode === 'balanced' ? 110 : TEXT_MIN_PARAGRAPH_LENGTH;
    const seen = new Set();
    const kept = [];
    let removedChars = 0;
    for (const paragraph of paragraphs) {
        const normalized = normalizeForExactMatch(paragraph);
        const eligible = looksLikeInstructionBlock(paragraph, minLength);
        if (eligible && seen.has(normalized)) {
            removedChars += paragraph.length;
            continue;
        }
        if (eligible) seen.add(normalized);
        kept.push(paragraph);
    }
    const next = kept.join('\n\n');
    if (next === eventData.prompt) return { changed: false, removedChars: 0 };
    eventData.prompt = next;
    return { changed: true, removedChars };
}

export function estimateTokensFromCharacters(characters) {
    return Math.max(0, Math.round(Number(characters || 0) / 4));
}
