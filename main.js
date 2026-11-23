
import { generateQuietPrompt } from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';

import {
    buildContinuityUpdate,
    getFileNames,
    loadContinuity,
    persistContinuity,
    syncLorebook
} from './continuity.js';

import {
    optimizeChatCompletionPayload,
    optimizeTextCompletionPayload,
    estimateTokensFromCharacters
} from './promptOptimizer.js';

const MODULE = 'gameManager';
const PREFIX = '[Game Manager]';

let pendingUpdate = null;
let extracting = false;

let promptStats = {
    runs: 0,
    removedChars: 0,
    lastSavedTokens: 0
};

const DEFAULTS = Object.freeze({
    promptOptimizer: true,
    promptMode: 'conservative',
    autoProcess: false,
    autoApplyDataBank: false,
    lorebookName: '',
    pending: null,

    panelExpanded: false,
    floatingOpen: false,
    floatingPosition: null
});

/* ==========================================
   CORE
========================================== */

function getContextSafe() {
    if (!globalThis.SillyTavern?.getContext) {
        throw new Error('SillyTavern context API is unavailable.');
    }

    return globalThis.SillyTavern.getContext();
}

function settings() {
    const ctx = getContextSafe();

    ctx.extensionSettings[MODULE] ??= {};

    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (ctx.extensionSettings[MODULE][key] === undefined) {
            ctx.extensionSettings[MODULE][key] = value;
        }
    }

    return ctx.extensionSettings[MODULE];
}

function activeCharacter() {
    const ctx = getContextSafe();

    if (ctx.groupId) {
        throw new Error(
            'Group-chat continuity updates are not enabled in this build.'
        );
    }

    const id = ctx.characterId;

    const character =
        id === undefined || id === null
            ? null
            : ctx.characters?.[id];

    if (!character?.avatar) {
        throw new Error('Open a 1:1 character chat first.');
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

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

/* ==========================================
   STATUS
========================================== */

function setStatus(message, error = false) {
    const node = document.getElementById('gm-status');

    if (node) {
        node.textContent = message;
        node.dataset.error = error ? 'true' : 'false';
    }

    updateFloatingUI();
}

/* ==========================================
   PENDING UPDATES
========================================== */

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

        updateFloatingUI();
        return;
    }

    box.innerHTML = `
        <div class="gm-preview">
            <b>${escapeHtml(p.characterName)}</b>

            <p>
                New timeline events: ${p.eventCount}
                · New world facts: ${p.loreCount}
            </p>

            <details>
                <summary>Preview current character state</summary>
                <pre>${escapeHtml(p.state)}</pre>
            </details>

            <details>
                <summary>Preview timeline</summary>
                <pre>${escapeHtml(p.timeline)}</pre>
            </details>
        </div>
    `;

    if (apply) apply.disabled = false;

    if (lore) {
        lore.disabled = !(p.worldFacts || []).length;
    }

    updateFloatingUI();
}

/* ==========================================
   EDITOR REFRESH
========================================== */

async function refreshEditors() {
    try {
        const character = activeCharacter();
        const ctx = getContextSafe();

        const data = await loadContinuity(character, ctx);

        document.getElementById('gm-state').value = data.state;
        document.getElementById('gm-timeline').value = data.timeline;
        document.getElementById('gm-lore').value = data.lore;

        document.getElementById('gm-memory-files').textContent =
            data.memoryFiles.length
                ? `CharMemory files detected: ${
                    data.memoryFiles.map(file => file.name).join(', ')
                }`
                : 'No CharMemory memory files detected for this character.';

        const cardState =
            character.data?.extensions?.game_manager?.characterState || '';

        document.getElementById('gm-card-state').textContent =
            cardState
                ? 'Character card extension data is present.'
                : 'No Game Manager state stored in this character card yet.';

    } catch (error) {
        const node = document.getElementById('gm-memory-files');

        if (node) node.textContent = error.message;
    }
}

/* ==========================================
   CHARMEMORY PROCESSING
========================================== */

async function processCharMemory() {
    if (extracting) return;

    extracting = true;

    setStatus('Reading CharMemory…');

    try {
        const character = activeCharacter();
        const ctx = getContextSafe();

        const existing = await loadContinuity(character, ctx);

        setStatus('Synthesizing continuity…');

        pendingUpdate = await buildContinuityUpdate(
            character,
            existing,
            generateQuietPrompt
        );

        settings().pending = pendingUpdate;

        ctx.saveSettingsDebounced();

        renderPending();

        setStatus('Review proposed updates');

        notify(
            'Continuity update prepared. Review it before applying.',
            'success'
        );

        if (settings().autoApplyDataBank) {
            await applyDataBankUpdate();
        }

    } catch (error) {
        console.error(PREFIX, error);

        setStatus('Processing failed', true);

        notify(error.message || String(error), 'error');

    } finally {
        extracting = false;
    }
}

/* ==========================================
   APPLY CHARACTER / DATABANK UPDATE
========================================== */

async function applyDataBankUpdate() {
    const p = pendingUpdate || settings().pending;

    if (!p) return;

    setStatus('Saving Data Bank and character state…');

    const character = activeCharacter();

    await persistContinuity(
        p,
        character,
        getContextSafe()
    );

    pendingUpdate = null;
    settings().pending = null;

    getContextSafe().saveSettingsDebounced();

    renderPending();

    await refreshEditors();

    setStatus('Data Bank and character metadata saved');

    notify(
        'Character state, timeline and lore archive saved. CharMemory files were not modified.',
        'success'
    );
}

/* ==========================================
   LOREBOOK
========================================== */

async function applyLorebookUpdate() {
    const p = pendingUpdate || settings().pending;

    if (!p) return;

    try {
        setStatus('Updating Lorebook…');

        const character = activeCharacter();

        const bookName =
            document.getElementById('gm-lorebook-name').value.trim()
            || settings().lorebookName;

        const result = await syncLorebook(
            p,
            character,
            getContextSafe(),
            bookName
        );

        settings().lorebookName = bookName;

        getContextSafe().saveSettingsDebounced();

        setStatus(
            `Lorebook updated: ${result.created} created, ${result.updated} updated`
        );

        notify(
            `Lorebook "${result.bookName}": ${result.created} entries created, ${result.updated} updated.`,
            'success'
        );

    } catch (error) {
        console.error(PREFIX, error);

        setStatus('Lorebook update failed', true);

        notify(error.message || String(error), 'error');
    }
}

/* ==========================================
   MANUAL EDITOR SAVING
========================================== */

async function saveEditor(kind) {
    const character = activeCharacter();
    const ctx = getContextSafe();

    const names = getFileNames(character.name);

    const value =
        document.getElementById(`gm-${kind}`).value;

    const suffix =
        kind === 'state'
            ? 'state'
            : kind === 'timeline'
                ? 'timeline'
                : 'lore';

    const { writeCharacterFile } =
        await import('./storage.js');

    await writeCharacterFile(
        character.avatar,
        names[suffix],
        value,
        ctx
    );

    if (
        kind === 'state'
        && typeof ctx.writeExtensionField === 'function'
        && ctx.characterId !== undefined
        && ctx.characterId !== null
    ) {
        await ctx.writeExtensionField(
            ctx.characterId,
            'game_manager',
            {
                version: 1,
                characterState: String(value || ''),
                updatedAt: new Date().toISOString(),
                source: 'Game Manager manual edit'
            }
        );

        refreshStateInjection(ctx);
    }

    setStatus(`${kind} saved`);

    await refreshEditors();
}

/* ==========================================
   PROMPT OPTIMIZER STATISTICS
========================================== */

function recordPromptStats(result) {
    if (!result?.changed || !result.removedChars) return;

    promptStats.runs++;

    promptStats.removedChars += result.removedChars;

    promptStats.lastSavedTokens =
        estimateTokensFromCharacters(result.removedChars);

    const node = document.getElementById('gm-prompt-stats');

    if (node) {
        node.textContent =
            `${promptStats.runs} prompts optimized · ` +
            `~${estimateTokensFromCharacters(
                promptStats.removedChars
            ).toLocaleString()} estimated tokens removed · ` +
            `last: ~${promptStats.lastSavedTokens} tokens`;
    }
}

/* ==========================================
   CHARACTER STATE PROMPT INJECTION
========================================== */

function refreshStateInjection(ctx) {
    if (typeof ctx.setExtensionPrompt !== 'function') return;

    try {
        const character = activeCharacter();

        const state = String(
            character.data?.extensions?.game_manager?.characterState || ''
        ).trim();

        const prompt = state
            ? `
[Persistent Character State — Game Manager]
${state}
Treat these as established continuity facts unless the current story explicitly changes them.
`
            : '';

        ctx.setExtensionPrompt(
            'GAME_MANAGER_CHARACTER_STATE',
            prompt,
            1,
            4,
            false,
            0
        );

    } catch (error) {
        try {
            ctx.setExtensionPrompt(
                'GAME_MANAGER_CHARACTER_STATE',
                '',
                1,
                4,
                false,
                0
            );
        } catch (_) {
            // No active character.
        }
    }
}

/* ==========================================
   PROMPT OPTIMIZER EVENT REGISTRATION
========================================== */

function registerPromptOptimizer(ctx) {
    const eventSource = ctx.eventSource;
    const types = ctx.eventTypes || ctx.event_types;

    if (!eventSource?.on || !types) {
        console.warn(
            PREFIX,
            'Prompt-ready events are unavailable; optimizer is disabled.'
        );
        return;
    }

    if (types.GENERATION_AFTER_COMMANDS) {
        eventSource.on(
            types.GENERATION_AFTER_COMMANDS,
            (_type, _options, dryRun) => {
                if (!dryRun) refreshStateInjection(ctx);
            }
        );
    }

    eventSource.on(
        types.CHAT_COMPLETION_PROMPT_READY,
        eventData => {
            const s = settings();

            if (!s.promptOptimizer || !eventData || eventData.dryRun) {
                return;
            }

            try {
                recordPromptStats(
                    optimizeChatCompletionPayload(
                        eventData,
                        s.promptMode
                    )
                );
            } catch (error) {
                console.warn(
                    PREFIX,
                    'Chat-completion prompt cleanup skipped.',
                    error
                );
            }
        }
    );

    eventSource.on(
        types.GENERATE_AFTER_COMBINE_PROMPTS,
        eventData => {
            const s = settings();

            if (!s.promptOptimizer || !eventData || eventData.dryRun) {
                return;
            }

            try {
                recordPromptStats(
                    optimizeTextCompletionPayload(
                        eventData,
                        s.promptMode
                    )
                );
            } catch (error) {
                console.warn(
                    PREFIX,
                    'Text-completion prompt cleanup skipped.',
                    error
                );
            }
        }
    );
}

/* ==========================================
   FLOATING UI — STATUS SYNCHRONIZATION
========================================== */

function updateFloatingUI() {
    const status =
        document.getElementById('gm-float-status');

    const mainStatus =
        document.getElementById('gm-status');

    const promptToggle =
        document.getElementById('gm-float-prompt');

    const applyData =
        document.getElementById('gm-float-apply-data');

    const applyLore =
        document.getElementById('gm-float-apply-lore');

    if (status) {
        status.textContent = mainStatus?.textContent || 'Idle';
    }

    if (promptToggle) {
        promptToggle.checked = !!settings().promptOptimizer;
    }

    const pending =
        pendingUpdate || settings().pending;

    if (applyData) {
        applyData.disabled = !pending;
    }

    if (applyLore) {
        applyLore.disabled =
            !pending || !(pending.worldFacts || []).length;
    }
}

/* ==========================================
   FLOATING UI — CREATION
========================================== */

function createFloatingUI(ctx) {
    if (document.getElementById('gm-floating')) return;

    const root = document.createElement('div');

    root.id = 'gm-floating';

    root.innerHTML = `
        <div
            id="gm-float-panel"
            class="${settings().floatingOpen ? 'gm-float-open' : ''}"
        >
            <div class="gm-float-head" id="gm-float-drag">
                <strong>
                    <i class="fa-solid fa-brain"></i>
                    Game Manager
                </strong>

                <button
                    class="gm-float-close"
                    id="gm-float-close"
                    type="button"
                    aria-label="Close"
                >×</button>
            </div>

            <div id="gm-float-status" class="gm-float-status">
                Idle
            </div>

            <button
                class="gm-float-button"
                id="gm-float-process"
                type="button"
            >
                <i class="fa-solid fa-arrows-rotate"></i>
                Process memories
            </button>

            <button
                class="gm-float-button"
                id="gm-float-apply-data"
                type="button"
                disabled
            >
                <i class="fa-solid fa-floppy-disk"></i>
                Apply character updates
            </button>

            <button
                class="gm-float-button"
                id="gm-float-apply-lore"
                type="button"
                disabled
            >
                <i class="fa-solid fa-book"></i>
                Synchronize Lorebook
            </button>

            <label class="gm-float-toggle">
                <input id="gm-float-prompt" type="checkbox">
                Prompt cleanup
            </label>
        </div>

        <button
            id="gm-float-launcher"
            type="button"
            title="Open Game Manager"
            aria-label="Open Game Manager"
        >
            <i class="fa-solid fa-brain"></i>
        </button>
    `;

    document.body.appendChild(root);

    const panel =
        root.querySelector('#gm-float-panel');

    const launcher =
        root.querySelector('#gm-float-launcher');

    const close =
        root.querySelector('#gm-float-close');

    const drag =
        root.querySelector('#gm-float-drag');

    const saved =
        settings().floatingPosition;

    if (
        saved
        && Number.isFinite(saved.left)
        && Number.isFinite(saved.top)
    ) {
        root.style.left = `${saved.left}px`;
        root.style.top = `${saved.top}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
    }

    function setFloatingOpen(open) {
        panel.classList.toggle('gm-float-open', open);

        settings().floatingOpen = open;

        ctx.saveSettingsDebounced();
    }

    launcher.addEventListener('click', () => {
        setFloatingOpen(
            !panel.classList.contains('gm-float-open')
        );
    });

    close.addEventListener('click', () => {
        setFloatingOpen(false);
    });

    root.querySelector('#gm-float-process')
        .addEventListener('click', processCharMemory);

    root.querySelector('#gm-float-apply-data')
        .addEventListener('click', () => {
            applyDataBankUpdate().catch(error => {
                notify(error.message || String(error), 'error');
            });
        });

    root.querySelector('#gm-float-apply-lore')
        .addEventListener('click', applyLorebookUpdate);

    root.querySelector('#gm-float-prompt')
        .addEventListener('change', event => {
            settings().promptOptimizer = event.target.checked;

            const mainToggle =
                document.getElementById('gm-prompt-enabled');

            if (mainToggle) {
                mainToggle.checked = event.target.checked;
            }

            ctx.saveSettingsDebounced();

            updateFloatingUI();
        });

    /* Dragging */

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

    const stopDragging = () => {
        if (!dragging) return;

        dragging = false;

        const rect = root.getBoundingClientRect();

        settings().floatingPosition = {
            left: Math.round(rect.left),
            top: Math.round(rect.top)
        };

        ctx.saveSettingsDebounced();
    };

    drag.addEventListener('pointerup', stopDragging);
    drag.addEventListener('pointercancel', stopDragging);

    updateFloatingUI();
}

/* ==========================================
   MAIN UI BINDING
========================================== */

function bindUI(ctx) {
    const s = settings();

    const content =
        document.getElementById('gm-content');

    const collapse =
        document.getElementById('gm-collapse-toggle');

    const expanded =
        !!s.panelExpanded;

    content.hidden = !expanded;

    collapse.setAttribute(
        'aria-expanded',
        String(expanded)
    );

    collapse.addEventListener('click', () => {
        const open = content.hidden;

        content.hidden = !open;

        collapse.setAttribute(
            'aria-expanded',
            String(open)
        );

        s.panelExpanded = open;

        ctx.saveSettingsDebounced();
    });

    /* Restore settings */

    document.getElementById('gm-prompt-enabled').checked =
        !!s.promptOptimizer;

    document.getElementById('gm-prompt-mode').value =
        s.promptMode;

    document.getElementById('gm-auto-process').checked =
        !!s.autoProcess;

    document.getElementById('gm-auto-apply').checked =
        !!s.autoApplyDataBank;

    document.getElementById('gm-lorebook-name').value =
        s.lorebookName || '';

    /* Prompt settings */

    document.getElementById('gm-prompt-enabled')
        .addEventListener('change', event => {
            s.promptOptimizer = event.target.checked;

            ctx.saveSettingsDebounced();

            updateFloatingUI();
        });

    document.getElementById('gm-prompt-mode')
        .addEventListener('change', event => {
            s.promptMode = event.target.value;

            ctx.saveSettingsDebounced();
        });

    /* Memory settings */

    document.getElementById('gm-auto-process')
        .addEventListener('change', event => {
            s.autoProcess = event.target.checked;

            ctx.saveSettingsDebounced();
        });

    document.getElementById('gm-auto-apply')
        .addEventListener('change', event => {
            s.autoApplyDataBank = event.target.checked;

            ctx.saveSettingsDebounced();
        });

    document.getElementById('gm-lorebook-name')
        .addEventListener('change', event => {
            s.lorebookName = event.target.value.trim();

            ctx.saveSettingsDebounced();
        });

    /* Main actions */

    document.getElementById('gm-process')
        .addEventListener('click', processCharMemory);

    document.getElementById('gm-apply-data')
        .addEventListener('click', () => {
            applyDataBankUpdate().catch(error => {
                notify(error.message || String(error), 'error');
            });
        });

    document.getElementById('gm-apply-lore')
        .addEventListener('click', applyLorebookUpdate);

    /* Manual editors */

    for (const kind of ['state', 'timeline', 'lore']) {
        document.getElementById(`gm-save-${kind}`)
            .addEventListener('click', () => {
                saveEditor(kind).catch(error => {
                    notify(error.message || String(error), 'error');
                });
            });
    }

    document.getElementById('gm-refresh')
        .addEventListener('click', refreshEditors);

    pendingUpdate = s.pending || null;

    renderPending();

    refreshEditors();

    createFloatingUI(ctx);
}

/* ==========================================
   INITIALIZATION
========================================== */

async function init() {
    const ctx = getContextSafe();

    settings();

    try {
        const html = await renderExtensionTemplateAsync(
            'third-party/game-manager',
            'settings'
        );

        document.getElementById('extensions_settings2')
            ?.insertAdjacentHTML('beforeend', html);

        bindUI(ctx);

    } catch (error) {
        console.error(
            PREFIX,
            'Could not load settings panel.',
            error
        );
    }

    registerPromptOptimizer(ctx);

    refreshStateInjection(ctx);

    const types =
        ctx.eventTypes || ctx.event_types;

    if (types?.CHAT_CHANGED) {
        ctx.eventSource.on(
            types.CHAT_CHANGED,
            () => {
                refreshStateInjection(ctx);

                pendingUpdate = settings().pending || null;

                setTimeout(() => {
                    renderPending();
                    refreshEditors();
                }, 350);
            }
        );
    }
}

/* ==========================================
   START
========================================== */

jQuery(async () => {
    try {
        await init();
    } catch (error) {
        console.error(
            PREFIX,
            'Initialization failed.',
            error
        );
    }
});
