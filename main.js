
import { generateQuietPrompt } from '../../../../script.js';
import { getContext, renderExtensionTemplateAsync } from '../../../extensions.js';

import {
    buildContinuityUpdate,
    loadContinuity,
    persistContinuity,
    syncLorebook
} from './continuity.js';

const MODULE = 'gameManager';
const PREFIX = '[Game Manager]';

let pendingUpdate = null;
let processing = false;
let applying = false;

const DEFAULTS = Object.freeze({
    lorebookName: '',
    pending: null,
    panelExpanded: false,
    floatingOpen: false,
    floatingPosition: null
});

/* ==========================================
   CONTEXT AND SETTINGS
========================================== */

function context() {
    return getContext();
}

function settings() {
    const ctx = context();
    ctx.extensionSettings[MODULE] ??= {};

    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (ctx.extensionSettings[MODULE][key] === undefined) {
            ctx.extensionSettings[MODULE][key] = value;
        }
    }

    return ctx.extensionSettings[MODULE];
}

function activeCharacter() {
    const ctx = context();

    if (ctx.groupId) {
        throw new Error('Group chats are not supported by this Game Manager build yet.');
    }

    const id = ctx.characterId;
    const character = id === undefined || id === null
        ? null
        : ctx.characters?.[id];

    if (!character?.avatar) {
        throw new Error('Open a 1:1 character chat before processing memories.');
    }

    const data = character.data || character;

    return {
        id,
        avatar: character.avatar,
        name: character.name || data.name || 'Character',
        data,
        card: [
            data.description,
            data.personality,
            data.scenario
        ].filter(Boolean).join('\n\n')
    };
}

function notify(message, type = 'info') {
    if (globalThis.toastr?.[type]) {
        globalThis.toastr[type](message, 'Game Manager');
    } else {
        console[type === 'error' ? 'error' : 'log'](PREFIX, message);
    }
}

function setStatus(message, isError = false) {
    const node = document.getElementById('gm-status');

    if (node) {
        node.textContent = message;
        node.dataset.error = isError ? 'true' : 'false';
    }

    const floating = document.getElementById('gm-float-status');
    if (floating) floating.textContent = message;
}

/* ==========================================
   PENDING UPDATE MANAGEMENT
========================================== */

function setPending(update) {
    pendingUpdate = update;
    settings().pending = update;
    context().saveSettingsDebounced();
    renderPending();
}

function clearPending() {
    pendingUpdate = null;
    settings().pending = null;
    context().saveSettingsDebounced();
    renderPending();
}

function renderPending() {
    const p = pendingUpdate || settings().pending;
    const summary = document.getElementById('gm-pending-summary');
    const apply = document.getElementById('gm-apply-all');
    const floatingApply = document.getElementById('gm-float-apply');

    if (!p) {
        if (summary) {
            summary.textContent =
                'No pending analysis. Analyze memories to prepare a review.';
        }

        if (apply) apply.disabled = true;
        if (floatingApply) floatingApply.disabled = true;
        return;
    }

    if (summary) {
        summary.textContent =
            `Review for ${p.characterName}: ` +
            `${p.eventCount || 0} new timeline events, ` +
            `${(p.worldFacts || []).length} proposed Lorebook entries. ` +
            'Edit any field before applying.';
    }

    if (apply) apply.disabled = false;
    if (floatingApply) floatingApply.disabled = false;
}

function fillReviewFields(update) {
    document.getElementById('gm-state').value = update.state || '';
    document.getElementById('gm-timeline').value = update.timeline || '';
    document.getElementById('gm-lore').value = update.lore || '';

    document.getElementById('gm-facts').value =
        JSON.stringify(update.worldFacts || [], null, 2);
}

function readReviewFields() {
    const p = pendingUpdate || settings().pending;

    if (!p) {
        throw new Error('There is no pending analysis to apply.');
    }

    let facts;

    try {
        facts = JSON.parse(
            document.getElementById('gm-facts').value || '[]'
        );
    } catch {
        throw new Error(
            'Lorebook entries contain invalid JSON. Correct the JSON before applying.'
        );
    }

    if (!Array.isArray(facts)) {
        throw new Error('Lorebook entries must be a JSON array.');
    }

    const worldFacts = facts.map((fact, index) => {
        const title = String(fact?.title || '').trim();
        const content = String(fact?.content || '').trim();

        const keys = Array.isArray(fact?.keys)
            ? fact.keys.map(value => String(value).trim()).filter(Boolean)
            : [];

        if (!title || !content) {
            throw new Error(
                `Lorebook entry ${index + 1} needs both a title and content.`
            );
        }

        return { title, keys, content };
    });

    return {
        ...p,
        state: document.getElementById('gm-state').value.trim(),
        timeline: document.getElementById('gm-timeline').value.trim(),
        lore: document.getElementById('gm-lore').value.trim(),
        worldFacts
    };
}

/* ==========================================
   READ EXISTING FILES
========================================== */

async function refreshSavedFiles() {
    try {
        const character = activeCharacter();
        const data = await loadContinuity(character, context());

        document.getElementById('gm-memory-files').textContent =
            data.memoryFiles.length
                ? `Found ${data.memoryFiles.length} CharMemory file(s): ${
                    data.memoryFiles.map(file => file.name).join(', ')
                }`
                : 'No CharMemory memory files found. Run CharMemory extraction first, then return here.';

        document.getElementById('gm-card-state').textContent =
            character.data?.extensions?.game_manager?.characterState
                ? 'Game Manager character-state metadata exists in this character card.'
                : 'No Game Manager character-state metadata exists yet.';

        return data;
    } catch (error) {
        const files = document.getElementById('gm-memory-files');

        if (files) files.textContent = error.message;

        throw error;
    }
}

/* ==========================================
   MANUAL ANALYSIS
   LLM CALL ONLY HAPPENS WHEN USER PRESSES
   THE ANALYZE BUTTON.
========================================== */

async function processConversation() {
    if (processing || applying) return;

    processing = true;

    const processButton =
        document.getElementById('gm-process');

    if (processButton) processButton.disabled = true;

    setStatus('Reading CharMemory files…');

    try {
        const character = activeCharacter();
        const ctx = context();

        const existing = await loadContinuity(character, ctx);

        if (!existing.memoryFiles.length) {
            throw new Error(
                'No CharMemory Data Bank memory file was found for this character. Run CharMemory extraction first.'
            );
        }

        setStatus('Analyzing story continuity…');

        const update = await buildContinuityUpdate(
            character,
            existing,
            generateQuietPrompt
        );

        setPending(update);
        fillReviewFields(update);

        setStatus('Review proposed changes');

        notify(
            'Analysis complete. Review and edit the proposed changes before applying.',
            'success'
        );

    } catch (error) {
        console.error(PREFIX, error);

        setStatus('Analysis failed', true);

        notify(error.message || String(error), 'error');

    } finally {
        processing = false;

        if (processButton) processButton.disabled = false;
    }
}

/* ==========================================
   CHARACTER STATE INJECTION
========================================== */

function injectCharacterState(state) {
    const ctx = context();

    if (typeof ctx.setExtensionPrompt !== 'function') return;

    const text = String(state || '').trim();

    const prompt = text
        ? `[Persistent Character State — Game Manager]\n${text}\nTreat these as established continuity facts unless explicitly changed by later events.`
        : '';

    ctx.setExtensionPrompt(
        'GAME_MANAGER_CHARACTER_STATE',
        prompt,
        1,
        4,
        false,
        0
    );
}

/* ==========================================
   APPLY APPROVED CHANGES
========================================== */

async function applyApprovedUpdates() {
    if (applying || processing) return;

    applying = true;

    const applyButton =
        document.getElementById('gm-apply-all');

    if (applyButton) applyButton.disabled = true;

    let dataBankSaved = false;

    try {
        const approved = readReviewFields();
        const character = activeCharacter();
        const ctx = context();

        if (approved.avatar !== character.avatar) {
            throw new Error(
                'The active character changed. Reopen the character used for this analysis and try again.'
            );
        }

        const bookName = (
            document.getElementById('gm-lorebook-name').value.trim()
            || settings().lorebookName
            || character.data?.extensions?.world
            || ''
        ).trim();

        if (approved.worldFacts.length && !bookName) {
            throw new Error(
                'The analysis contains Lorebook entries, but no Lorebook is selected. Enter an existing Lorebook name before applying.'
            );
        }

        settings().lorebookName = bookName;
        ctx.saveSettingsDebounced();

        setStatus('Saving character state and continuity files…');

        // Save Data Bank files and character-card extension metadata.
        await persistContinuity(
            approved,
            character,
            ctx
        );

        dataBankSaved = true;

        // Update the active character's continuity prompt.
        injectCharacterState(approved.state);

        // Synchronize Lorebook entries only after approval.
        if (approved.worldFacts.length) {
            setStatus('Synchronizing approved Lorebook entries…');

            const result = await syncLorebook(
                approved,
                character,
                ctx,
                bookName
            );

            notify(
                `Character state saved. Lorebook "${result.bookName}": ${result.created} created, ${result.updated} updated.`,
                'success'
            );
        } else {
            notify(
                'Character state, timeline and lore archive saved. No Lorebook entries were proposed.',
                'success'
            );
        }

        clearPending();

        await refreshSavedFiles();

        setStatus('Approved updates saved');

    } catch (error) {
        console.error(PREFIX, error);

        if (dataBankSaved) {
            setStatus('Character saved; Lorebook sync needs attention', true);

            notify(
                `Character state and continuity files were saved, but the remaining step failed: ${error.message}. The pending review has been kept so you can retry.`,
                'error'
            );
        } else {
            setStatus('Update not applied', true);
            notify(error.message || String(error), 'error');
        }

    } finally {
        applying = false;

        if (applyButton) {
            applyButton.disabled = !(pendingUpdate || settings().pending);
        }

        renderPending();
    }
}

/* ==========================================
   COLLAPSIBLE EXTENSION PANEL
========================================== */

function bindCollapsiblePanel(ctx) {
    const content = document.getElementById('gm-content');
    const toggle = document.getElementById('gm-collapse-toggle');

    const open = !!settings().panelExpanded;

    content.hidden = !open;

    toggle.setAttribute(
        'aria-expanded',
        String(open)
    );

    toggle.addEventListener('click', () => {
        const nextOpen = content.hidden;

        content.hidden = !nextOpen;

        toggle.setAttribute(
            'aria-expanded',
            String(nextOpen)
        );

        settings().panelExpanded = nextOpen;

        ctx.saveSettingsDebounced();
    });
}

/* ==========================================
   FLOATING QUICK-ACCESS WINDOW
========================================== */

function createFloatingUI(ctx) {
    if (document.getElementById('gm-floating')) return;

    const root = document.createElement('div');

    root.id = 'gm-floating';

    root.innerHTML = `
        <div id="gm-float-panel"
             class="${settings().floatingOpen ? 'gm-float-open' : ''}">

            <div class="gm-float-head" id="gm-float-drag">
                <strong>
                    <i class="fa-solid fa-brain"></i>
                    Game Manager
                </strong>

                <button class="gm-float-close"
                        id="gm-float-close"
                        type="button"
                        aria-label="Close">×</button>
            </div>

            <div id="gm-float-status" class="gm-float-status">
                Idle
            </div>

            <button class="gm-float-button"
                    id="gm-float-process"
                    type="button">
                <i class="fa-solid fa-magnifying-glass"></i>
                Analyze memories
            </button>

            <button class="gm-float-button"
                    id="gm-float-apply"
                    type="button"
                    disabled>
                <i class="fa-solid fa-check"></i>
                Apply approved updates
            </button>
        </div>

        <button id="gm-float-launcher"
                type="button"
                title="Open Game Manager"
                aria-label="Open Game Manager">
            <i class="fa-solid fa-brain"></i>
        </button>
    `;

    document.body.appendChild(root);

    const panel = root.querySelector('#gm-float-panel');
    const drag = root.querySelector('#gm-float-drag');

    const saved = settings().floatingPosition;

    if (
        saved &&
        Number.isFinite(saved.left) &&
        Number.isFinite(saved.top)
    ) {
        root.style.left = `${saved.left}px`;
        root.style.top = `${saved.top}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
    }

    function setOpen(open) {
        panel.classList.toggle('gm-float-open', open);

        settings().floatingOpen = open;

        ctx.saveSettingsDebounced();
    }

    root.querySelector('#gm-float-launcher')
        .addEventListener('click', () => {
            setOpen(!panel.classList.contains('gm-float-open'));
        });

    root.querySelector('#gm-float-close')
        .addEventListener('click', () => setOpen(false));

    root.querySelector('#gm-float-process')
        .addEventListener('click', processConversation);

    root.querySelector('#gm-float-apply')
        .addEventListener('click', applyApprovedUpdates);

    /* Drag handling */

    let dragging = false;

    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    drag.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) return;

        dragging = true;

        const rect = root.getBoundingClientRect();

        startX = event.clientX;
        startY = event.clientY;

        startLeft = rect.left;
        startTop = rect.top;

        drag.setPointerCapture(event.pointerId);

        event.preventDefault();
    });

    drag.addEventListener('pointermove', event => {
        if (!dragging) return;

        const left = Math.max(
            0,
            Math.min(
                window.innerWidth - root.offsetWidth,
                startLeft + event.clientX - startX
            )
        );

        const top = Math.max(
            0,
            Math.min(
                window.innerHeight - root.offsetHeight,
                startTop + event.clientY - startY
            )
        );

        root.style.left = `${left}px`;
        root.style.top = `${top}px`;

        root.style.right = 'auto';
        root.style.bottom = 'auto';
    });

    function stopDragging() {
        if (!dragging) return;

        dragging = false;

        const rect = root.getBoundingClientRect();

        settings().floatingPosition = {
            left: Math.round(rect.left),
            top: Math.round(rect.top)
        };

        ctx.saveSettingsDebounced();
    }

    drag.addEventListener('pointerup', stopDragging);
    drag.addEventListener('pointercancel', stopDragging);
}

/* ==========================================
   UI BINDING
========================================== */

function bindUI(ctx) {
    bindCollapsiblePanel(ctx);

    document.getElementById('gm-process')
        .addEventListener('click', processConversation);

    document.getElementById('gm-apply-all')
        .addEventListener('click', applyApprovedUpdates);

    document.getElementById('gm-refresh')
        .addEventListener('click', async () => {
            try {
                await refreshSavedFiles();
                notify('Saved continuity files reloaded.', 'success');
            } catch (error) {
                notify(error.message || String(error), 'error');
            }
        });

    document.getElementById('gm-lorebook-name').value =
        settings().lorebookName || '';

    document.getElementById('gm-lorebook-name')
        .addEventListener('change', event => {
            settings().lorebookName = event.target.value.trim();
            ctx.saveSettingsDebounced();
        });

    // Restore an unfinished review after reloading SillyTavern.
    pendingUpdate = settings().pending || null;

    if (pendingUpdate) {
        fillReviewFields(pendingUpdate);
    }

    renderPending();
    createFloatingUI(ctx);

    refreshSavedFiles().catch(error => {
        console.warn(PREFIX, 'Initial file refresh failed:', error);
    });
}

/* ==========================================
   INITIALIZATION
========================================== */

async function init() {
    const ctx = context();

    settings();

    const html = await renderExtensionTemplateAsync(
        'third-party/game-manager',
        'settings'
    );

    document.getElementById('extensions_settings2')
        ?.insertAdjacentHTML('beforeend', html);

    bindUI(ctx);

    /*
     * Deliberately no prompt optimizer.
     * No generation interceptors.
     * No per-message extraction.
     *
     * Character state is injected only after approval
     * and when the active chat changes.
     */

    const eventTypes = ctx.eventTypes || ctx.event_types;

    if (eventTypes?.CHAT_CHANGED && ctx.eventSource?.on) {
        ctx.eventSource.on(eventTypes.CHAT_CHANGED, () => {
            setTimeout(() => {
                try {
                    const character = activeCharacter();

                    const state =
                        character.data?.extensions?.game_manager?.characterState || '';

                    injectCharacterState(state);

                    refreshSavedFiles().catch(error => {
                        console.warn(PREFIX, error);
                    });

                } catch {
                    // No active solo character.
                }
            }, 300);
        });
    }

    try {
        const character = activeCharacter();

        injectCharacterState(
            character.data?.extensions?.game_manager?.characterState || ''
        );
    } catch {
        // Welcome screen or no active character.
    }
}

jQuery(async () => {
    try {
        await init();
    } catch (error) {
        console.error(PREFIX, 'Initialization failed.', error);
        notify(error.message || String(error), 'error');
    }
});
