import { generateQuietPrompt } from '../../../../script.js';
import { getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { buildContinuityUpdate, getFileNames, loadContinuity, persistContinuity, syncLorebook } from './continuity.js';
import { optimizeChatCompletionPayload, optimizeTextCompletionPayload, estimateTokensFromCharacters } from './promptOptimizer.js';

const MODULE = 'gameManager';
const PREFIX = '[Game Manager]';
let pendingUpdate = null;
let extracting = false;
let promptStats = { runs: 0, removedChars: 0, lastSavedTokens: 0 };

const DEFAULTS = Object.freeze({
    promptOptimizer: true,
    promptMode: 'conservative',
    autoProcess: false,
    autoApplyDataBank: false,
    lorebookName: '',
    pending: null,
});

function getContextSafe() {
    if (!globalThis.SillyTavern?.getContext) throw new Error('SillyTavern context API is unavailable.');
    return globalThis.SillyTavern.getContext();
}

function settings() {
    const ctx = getContextSafe();
    ctx.extensionSettings[MODULE] ??= {};
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (ctx.extensionSettings[MODULE][key] === undefined) ctx.extensionSettings[MODULE][key] = value;
    }
    return ctx.extensionSettings[MODULE];
}

function activeCharacter() {
    const ctx = getContextSafe();
    if (ctx.groupId) throw new Error('Group-chat continuity updates are not enabled in this build. CharMemory group memory files remain untouched.');
    const id = ctx.characterId;
    const character = id === undefined || id === null ? null : ctx.characters?.[id];
    if (!character?.avatar) throw new Error('Open a 1:1 character chat first.');
    const data = character.data || character;
    return {
        id,
        avatar: character.avatar,
        name: character.name || data.name || 'Character',
        data,
        card: [data.description, data.personality, data.scenario].filter(Boolean).join('\n\n'),
    };
}

function setStatus(message, error = false) {
    const node = document.getElementById('gm-status');
    if (node) {
        node.textContent = message;
        node.dataset.error = error ? 'true' : 'false';
    }
}

function notify(message, type = 'info') {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message, 'Game Manager');
    else console[type === 'error' ? 'error' : 'log'](PREFIX, message);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderPending() {
    const box = document.getElementById('gm-pending');
    const apply = document.getElementById('gm-apply-data');
    const lore = document.getElementById('gm-apply-lore');
    if (!box) return;
    const p = pendingUpdate || settings().pending;
    if (!p) {
        box.textContent = 'No proposed updates.';
        if (apply) apply.disabled = true;
        if (lore) lore.disabled = true;
        return;
    }
    box.innerHTML = `<div class="gm-preview"><b>${escapeHtml(p.characterName)}</b><p>New timeline events: ${p.eventCount} · New world facts: ${p.loreCount}</p><details><summary>Preview current character state</summary><pre>${escapeHtml(p.state)}</pre></details><details><summary>Preview timeline</summary><pre>${escapeHtml(p.timeline)}</pre></details></div>`;
    if (apply) apply.disabled = false;
    if (lore) lore.disabled = !(p.worldFacts || []).length;
}

async function refreshEditors() {
    try {
        const character = activeCharacter();
        const ctx = getContextSafe();
        const data = await loadContinuity(character, ctx);
        document.getElementById('gm-state').value = data.state;
        document.getElementById('gm-timeline').value = data.timeline;
        document.getElementById('gm-lore').value = data.lore;
        document.getElementById('gm-memory-files').textContent = data.memoryFiles.length
            ? `CharMemory files detected: ${data.memoryFiles.map(file => file.name).join(', ')}`
            : 'No CharMemory memory files detected for this character.';
        const cardState = character.data?.extensions?.game_manager?.characterState || '';
        document.getElementById('gm-card-state').textContent = cardState ? 'Character card extension data is present.' : 'No Game Manager state stored in this character card yet.';
    } catch (error) {
        document.getElementById('gm-memory-files').textContent = error.message;
    }
}

async function processCharMemory() {
    if (extracting) return;
    extracting = true;
    setStatus('Reading CharMemory…');
    try {
        const character = activeCharacter();
        const ctx = getContextSafe();
        const existing = await loadContinuity(character, ctx);
        setStatus('Synthesizing continuity…');
        pendingUpdate = await buildContinuityUpdate(character, existing, generateQuietPrompt);
        settings().pending = pendingUpdate;
        ctx.saveSettingsDebounced();
        renderPending();
        setStatus('Review proposed updates');
        notify('Continuity update prepared. Review it before applying.', 'success');
        if (settings().autoApplyDataBank) await applyDataBankUpdate();
    } catch (error) {
        console.error(PREFIX, error);
        setStatus('Processing failed', true);
        notify(error.message || String(error), 'error');
    } finally {
        extracting = false;
    }
}

async function applyDataBankUpdate() {
    const p = pendingUpdate || settings().pending;
    if (!p) return;
    setStatus('Saving Data Bank and character state…');
    const character = activeCharacter();
    await persistContinuity(p, character, getContextSafe());
    pendingUpdate = null;
    settings().pending = null;
    getContextSafe().saveSettingsDebounced();
    renderPending();
    await refreshEditors();
    setStatus('Data Bank and character metadata saved');
    notify('Character state, timeline and lore archive saved. CharMemory files were not modified.', 'success');
}

async function applyLorebookUpdate() {
    const p = pendingUpdate || settings().pending;
    if (!p) return;
    try {
        setStatus('Updating Lorebook…');
        const character = activeCharacter();
        const bookName = document.getElementById('gm-lorebook-name').value.trim() || settings().lorebookName;
        const result = await syncLorebook(p, character, getContextSafe(), bookName);
        settings().lorebookName = bookName;
        getContextSafe().saveSettingsDebounced();
        setStatus(`Lorebook updated: ${result.created} created, ${result.updated} updated`);
        notify(`Lorebook "${result.bookName}": ${result.created} entries created, ${result.updated} updated.`, 'success');
    } catch (error) {
        console.error(PREFIX, error);
        setStatus('Lorebook update failed', true);
        notify(error.message || String(error), 'error');
    }
}

async function saveEditor(kind) {
    const character = activeCharacter();
    const ctx = getContextSafe();
    const names = getFileNames(character.name);
    const value = document.getElementById(`gm-${kind}`).value;
    const suffix = kind === 'state' ? 'state' : kind === 'timeline' ? 'timeline' : 'lore';
    const { writeCharacterFile } = await import('./storage.js');
    await writeCharacterFile(character.avatar, names[suffix], value, ctx);
    if (kind === 'state' && typeof ctx.writeExtensionField === 'function' && ctx.characterId !== undefined && ctx.characterId !== null) {
        await ctx.writeExtensionField(ctx.characterId, 'game_manager', { version: 1, characterState: String(value || ''), updatedAt: new Date().toISOString(), source: 'Game Manager manual edit' });
        refreshStateInjection(ctx);
    }
    setStatus(`${kind} saved`);
    await refreshEditors();
}

function recordPromptStats(result) {
    if (!result?.changed || !result.removedChars) return;
    promptStats.runs++;
    promptStats.removedChars += result.removedChars;
    promptStats.lastSavedTokens = estimateTokensFromCharacters(result.removedChars);
    const node = document.getElementById('gm-prompt-stats');
    if (node) node.textContent = `${promptStats.runs} prompts optimized · ~${estimateTokensFromCharacters(promptStats.removedChars).toLocaleString()} estimated tokens removed · last: ~${promptStats.lastSavedTokens} tokens`;
}

function refreshStateInjection(ctx) {
    if (typeof ctx.setExtensionPrompt !== 'function') return;
    try {
        const character = activeCharacter();
        const state = String(character.data?.extensions?.game_manager?.characterState || '').trim();
        const prompt = state ? `
[Persistent Character State — Game Manager]
${state}
Treat these as established continuity facts unless the current story explicitly changes them.` : '';
        // SillyTavern extension prompt types: 1 = relative/in-prompt; role 0 = system.
        ctx.setExtensionPrompt('GAME_MANAGER_CHARACTER_STATE', prompt, 1, 4, false, 0);
    } catch (error) {
        // No active solo character (e.g. group chat or welcome screen): clear stale state.
        try { ctx.setExtensionPrompt('GAME_MANAGER_CHARACTER_STATE', '', 1, 4, false, 0); } catch (_) { /* ignore */ }
    }
}

function registerPromptOptimizer(ctx) {
    const eventSource = ctx.eventSource;
    const types = ctx.eventTypes || ctx.event_types;
    if (!eventSource?.on || !types) {
        console.warn(PREFIX, 'Prompt-ready events are unavailable; optimizer is disabled.');
        return;
    }
    if (types.GENERATION_AFTER_COMMANDS) {
        eventSource.on(types.GENERATION_AFTER_COMMANDS, (_type, _options, dryRun) => {
            if (!dryRun) refreshStateInjection(ctx);
        });
    }
    eventSource.on(types.CHAT_COMPLETION_PROMPT_READY, eventData => {
        const s = settings();
        if (!s.promptOptimizer || !eventData || eventData.dryRun) return;
        try { recordPromptStats(optimizeChatCompletionPayload(eventData, s.promptMode)); }
        catch (error) { console.warn(PREFIX, 'Chat-completion prompt cleanup skipped.', error); }
    });
    eventSource.on(types.GENERATE_AFTER_COMBINE_PROMPTS, eventData => {
        const s = settings();
        if (!s.promptOptimizer || !eventData || eventData.dryRun) return;
        try { recordPromptStats(optimizeTextCompletionPayload(eventData, s.promptMode)); }
        catch (error) { console.warn(PREFIX, 'Text-completion prompt cleanup skipped.', error); }
    });
}

function bindUI(ctx) {
    const s = settings();
    document.getElementById('gm-prompt-enabled').checked = !!s.promptOptimizer;
    document.getElementById('gm-prompt-mode').value = s.promptMode;
    document.getElementById('gm-auto-process').checked = !!s.autoProcess;
    document.getElementById('gm-auto-apply').checked = !!s.autoApplyDataBank;
    document.getElementById('gm-lorebook-name').value = s.lorebookName || '';
    document.getElementById('gm-prompt-enabled').addEventListener('change', event => { s.promptOptimizer = event.target.checked; ctx.saveSettingsDebounced(); });
    document.getElementById('gm-prompt-mode').addEventListener('change', event => { s.promptMode = event.target.value; ctx.saveSettingsDebounced(); });
    document.getElementById('gm-auto-process').addEventListener('change', event => { s.autoProcess = event.target.checked; ctx.saveSettingsDebounced(); });
    document.getElementById('gm-auto-apply').addEventListener('change', event => { s.autoApplyDataBank = event.target.checked; ctx.saveSettingsDebounced(); });
    document.getElementById('gm-lorebook-name').addEventListener('change', event => { s.lorebookName = event.target.value.trim(); ctx.saveSettingsDebounced(); });
    document.getElementById('gm-process').addEventListener('click', processCharMemory);
    document.getElementById('gm-apply-data').addEventListener('click', () => applyDataBankUpdate().catch(error => notify(error.message, 'error')));
    document.getElementById('gm-apply-lore').addEventListener('click', applyLorebookUpdate);
    for (const kind of ['state', 'timeline', 'lore']) {
        document.getElementById(`gm-save-${kind}`).addEventListener('click', () => saveEditor(kind).catch(error => notify(error.message, 'error')));
    }
    document.getElementById('gm-refresh').addEventListener('click', refreshEditors);
    pendingUpdate = s.pending || null;
    renderPending();
    refreshEditors();
}

async function init() {
    const ctx = getContextSafe();
    settings();
    try {
        const html = await renderExtensionTemplateAsync('third-party/game-manager', 'settings');
        document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);
        bindUI(ctx);
    } catch (error) {
        console.error(PREFIX, 'Could not load settings panel.', error);
    }
    registerPromptOptimizer(ctx);
    refreshStateInjection(ctx);
    const types = ctx.eventTypes || ctx.event_types;
    if (types?.CHAT_CHANGED) ctx.eventSource.on(types.CHAT_CHANGED, () => {
        refreshStateInjection(ctx);
        pendingUpdate = settings().pending || null;
        setTimeout(() => { renderPending(); refreshEditors(); }, 350);
    });
}

jQuery(async () => {
    try { await init(); }
    catch (error) { console.error(PREFIX, 'Initialization failed.', error); }
});
