# Game Manager 0.2.0

A SillyTavern companion extension for CharMemory and built-in Vector Storage. This build adds:

- Read-only discovery and reading of CharMemory Data Bank memory files.
- A continuity synthesis workflow that creates separate character-state, event-timeline, and world-lore Markdown files.
- Character-card extension metadata stored under `data.extensions.game_manager` through SillyTavern's `writeExtensionField` API.
- Optional synchronization of extracted world facts into an existing character-bound World Info/Lorebook using `loadWorldInfo` and `saveWorldInfo`.
- A deterministic prompt optimizer registered on `CHAT_COMPLETION_PROMPT_READY` and `GENERATE_AFTER_COMBINE_PROMPTS`.

## Install

1. Back up your SillyTavern `data` directory.
2. Extract this folder to `data/<user>/extensions/third-party/game-manager/`.
3. Restart SillyTavern or reload extensions.
4. Enable Game Manager in Extensions.
5. Keep CharMemory and SillyTavern Vector Storage enabled. Enable Vector Storage file indexing for the Data Bank files if you want retrieval of Game Manager continuity files.
6. Open a 1:1 character chat and use **Process CharMemory memories**.

## Prompt optimizer safety

The optimizer does not use the generation interceptor because that hook receives a mutable chat-history array. Instead, it listens to the final prompt-ready events:

- `CHAT_COMPLETION_PROMPT_READY`: only string content in `system` / `developer` messages (or explicitly system messages) is eligible.
- `GENERATE_AFTER_COMBINE_PROMPTS`: only long, instruction-like duplicate paragraphs are eligible.

It does not edit user/assistant messages, multimodal content, code blocks, XML-like memory blocks, or stored chat files. No LLM call is made during prompt cleanup. Token savings shown are estimates based on removed characters (approximately 4 characters per token), not tokenizer-exact measurements.

## Character card behavior

Game Manager stores the current continuity summary in the character card's extension metadata field `data.extensions.game_manager`. It does not overwrite the original Description, Personality, or Scenario fields. This is deliberate: the original card remains the identity baseline, while the evolving state is maintained separately and injected only if a future state-injection module is enabled.

## Lorebook behavior

Lorebook synchronization targets the existing character-bound book (`character.data.extensions.world`) or the explicit book name entered in the panel. It creates/updates entries marked `GM: <title>`. Unrelated entries are not modified. Back up the Lorebook before first use. Lorebook sync is a separate explicit action from saving Data Bank continuity files.

## Known limitations

- Group-chat continuity processing is not enabled in this build. CharMemory group files are not modified.
- The automatic CharMemory-to-Game-Manager background sync toggle is reserved/disabled; use the explicit processing button to avoid competing LLM calls with CharMemory.
- Character state is stored in card extension metadata, not rewritten into the visible Description/Personality/Scenario text fields.
- World Info entry fields and prompt-ready event payloads should be verified against the user's installed SillyTavern version before enabling automatic operation broadly.
- Vector Storage indexing is controlled by SillyTavern; Game Manager does not call undocumented vector endpoints.

## Development checks

Run `node --check` on each `.js` file. Live validation requires a running SillyTavern instance with CharMemory, Data Bank and Vector Storage installed.
