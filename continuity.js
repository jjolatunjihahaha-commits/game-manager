import { readCharacterFile, writeCharacterFile, readCharMemoryFiles, safeFilePart } from './storage.js';

const FILE_SUFFIX = {
    state: 'gm-character-state.md',
    timeline: 'gm-event-timeline.md',
    lore: 'gm-world-lore.md',
};

export function getFileNames(characterName) {
    const safe = safeFilePart(characterName);
    return Object.fromEntries(Object.entries(FILE_SUFFIX).map(([key, suffix]) => [key, `${safe}-${suffix}`]));
}

function parseJsonResponse(raw) {
    const text = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(text); } catch (_) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
        throw new Error('The extraction model did not return valid JSON. No files were changed.');
    }
}

function appendUnique(existing, additions) {
    let result = String(existing || '').trim();
    for (const addition of additions) {
        const item = String(addition || '').trim();
        if (item && !result.toLowerCase().includes(item.toLowerCase())) result += `${result ? '\n\n' : ''}${item}`;
    }
    return result;
}

function normalizeEvents(events, characterName) {
    return (Array.isArray(events) ? events : []).map(event => {
        const title = String(event?.title || 'Untitled event').trim();
        const details = String(event?.details || '').trim();
        if (!details) return '';
        const date = String(event?.date || 'Date unknown').trim();
        return `## ${title}\n- Date: ${date}\n- Participants: ${String(event?.participants || characterName).trim()}\n- ${details}`;
    }).filter(Boolean);
}

function normalizeLoreFacts(facts) {
    return (Array.isArray(facts) ? facts : []).map(fact => {
        if (typeof fact === 'string') return { title: fact.slice(0, 80), keys: [], content: fact.trim() };
        return {
            title: String(fact?.title || 'Untitled world fact').trim(),
            keys: Array.isArray(fact?.keys) ? fact.keys.map(String).map(x => x.trim()).filter(Boolean).slice(0, 12) : [],
            content: String(fact?.content || '').trim(),
        };
    }).filter(fact => fact.content);
}

export async function loadContinuity(character, context) {
    const names = getFileNames(character.name);
    const [state, timeline, lore, memoryFiles] = await Promise.all([
        readCharacterFile(character.avatar, names.state, context.extensionSettings),
        readCharacterFile(character.avatar, names.timeline, context.extensionSettings),
        readCharacterFile(character.avatar, names.lore, context.extensionSettings),
        readCharMemoryFiles(character.avatar, context.extensionSettings),
    ]);
    return { names, state, timeline, lore, memoryFiles };
}

export async function buildContinuityUpdate(character, existing, generateQuietPrompt) {
    if (!existing.memoryFiles.length) {
        throw new Error('No CharMemory Data Bank file was found for this character. Run a CharMemory extraction first.');
    }
    const source = existing.memoryFiles.map(file => `### ${file.name}\n${file.content}`).join('\n\n');
    const prompt = `You are Game Manager, a continuity editor working alongside CharMemory. CharMemory is the source of historical memory blocks; do not rewrite or duplicate its files. Produce an updated current-state summary, only genuinely new timeline events, and durable world-lore facts.\n\nRules:\n- Use only facts explicitly supported by the CharMemory files below.\n- Distinguish confirmed events from plans, hypotheticals, dreams, jokes, and uncertain claims.\n- Do not infer consent, marriage, pregnancy, death, ownership, or relationship status.\n- Preserve established facts unless a later explicit event changes them.\n- Do not invent dates. Use 'unknown' when absent.\n- Keep the current-state summary concise, factual, and written for future prompt injection.\n- Do not copy the character's baseline personality or appearance into state.\n- Events must describe durable changes or consequential experiences, not routine dialogue.\n- World facts must be stable setting facts, not private character memories.\n- Return valid JSON only.\n\nCHARACTER: ${character.name}\nBASE CHARACTER CARD (identity baseline):\n${character.card.slice(0, 5000)}\n\nEXISTING CURRENT STATE:\n${existing.state.slice(0, 7000) || '(empty)'}\n\nEXISTING TIMELINE:\n${existing.timeline.slice(-9000) || '(empty)'}\n\nEXISTING WORLD LORE:\n${existing.lore.slice(0, 7000) || '(empty)'}\n\nCHARMEMORY SOURCE FILES (read-only):\n${source.slice(-26000)}\n\nRequired JSON shape:\n{\n  "state_summary": "complete updated current-state Markdown",\n  "events": [{"date":"YYYY-MM-DD or unknown","title":"short title","participants":"names","details":"confirmed event and outcome"}],\n  "world_facts": [{"title":"short title","keys":["trigger","keywords"],"content":"standalone lorebook content"}]\n}\nUse empty arrays when there are no new events or world facts. Return the full updated state summary, not a patch.`;
    const raw = await generateQuietPrompt({ quietPrompt: prompt, skipWIAN: true, responseLength: 2200 });
    const data = parseJsonResponse(raw);
    const state = String(data.state_summary || existing.state || '').trim();
    const events = normalizeEvents(data.events, character.name);
    const worldFacts = normalizeLoreFacts(data.world_facts);
    return {
        state,
        timeline: appendUnique(existing.timeline, events),
        lore: appendUnique(existing.lore, worldFacts.map(fact => `## ${fact.title}\n${fact.content}`)),
        worldFacts,
        eventCount: events.length,
        loreCount: worldFacts.length,
        sourceFiles: existing.memoryFiles.map(file => file.name),
        names: existing.names,
        avatar: character.avatar,
        characterName: character.name,
        createdAt: Date.now(),
    };
}

export async function persistContinuity(pending, character, context) {
    if (pending.avatar !== character.avatar) throw new Error('The active character changed. Reopen the correct character before applying this update.');
    // Sequential writes avoid races in SillyTavern's shared character_attachments array.
    await writeCharacterFile(character.avatar, pending.names.state, pending.state, context);
    await writeCharacterFile(character.avatar, pending.names.timeline, pending.timeline, context);
    await writeCharacterFile(character.avatar, pending.names.lore, pending.lore, context);

    if (typeof context.writeExtensionField !== 'function' || context.characterId === undefined || context.characterId === null) {
        throw new Error('Data Bank files were saved, but this SillyTavern version does not expose writeExtensionField for character-card metadata.');
    }
    await context.writeExtensionField(context.characterId, 'game_manager', {
        version: 1,
        characterState: pending.state,
        updatedAt: new Date().toISOString(),
        source: 'Game Manager / CharMemory sync',
    });
    return true;
}

export async function syncLorebook(pending, character, context, bookNameOverride = '') {
    const bookName = String(bookNameOverride || character.data?.extensions?.world || '').trim();
    if (!bookName) throw new Error('No character-bound Lorebook was found. Enter an existing Lorebook name in Game Manager settings.');
    if (typeof context.loadWorldInfo !== 'function' || typeof context.saveWorldInfo !== 'function') {
        throw new Error('This SillyTavern version does not expose loadWorldInfo/saveWorldInfo. Lorebook synchronization is unavailable.');
    }
    const world = await context.loadWorldInfo(bookName);
    if (!world || !world.entries) throw new Error(`Could not load Lorebook "${bookName}".`);
    const entries = world.entries;
    let nextUid = Math.max(0, ...Object.keys(entries).map(key => Number(key)).filter(Number.isFinite)) + 1;
    let created = 0;
    let updated = 0;
    for (const fact of pending.worldFacts || []) {
        const marker = `GM: ${fact.title}`;
        const existingEntry = Object.values(entries).find(entry => entry?.comment === marker || entry?.game_manager_key === marker);
        const uid = existingEntry?.uid ?? nextUid++;
        const old = existingEntry || {};
        entries[uid] = {
            ...old,
            uid,
            key: fact.keys?.length ? fact.keys : [fact.title],
            keysecondary: old.keysecondary || [],
            comment: marker,
            content: fact.content,
            constant: false,
            selective: true,
            selectiveLogic: old.selectiveLogic ?? 0,
            order: old.order ?? 100,
            position: old.position ?? 0,
            disable: false,
            probability: 100,
            depth: old.depth ?? 4,
            group: old.group || '',
            group_override: old.group_override ?? false,
            group_weight: old.group_weight ?? 100,
            scanDepth: old.scanDepth ?? 0,
            caseSensitive: old.caseSensitive ?? false,
            matchWholeWords: old.matchWholeWords ?? false,
            useGroupScoring: old.useGroupScoring ?? false,
            automationId: old.automationId || '',
            role: old.role ?? 0,
            sticky: old.sticky ?? 0,
            cooldown: old.cooldown ?? 0,
            delay: old.delay ?? 0,
            addMemo: true,
            game_manager_key: marker,
        };
        if (existingEntry) updated++; else created++;
    }
    await context.saveWorldInfo(bookName, world, true);
    return { bookName, created, updated };
}
