// Lightweight React drawer (compiled into one file)
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { getPendingUpdates, applyCardUpdate, applyLoreUpdate, generateFirstMessage } from '../main.js';

function GameManagerDrawer() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(getPendingUpdates());

  useEffect(() => {
    const id = setInterval(() => setData(getPendingUpdates()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!open) {
    return (
      React.createElement('div', { className: 'ext-drawer-header', onClick: () => setOpen(true) }, '▶ Game Manager')
    );
  }

  return (
    React.createElement('div', { className: 'ext-drawer' },
      React.createElement('div', { className: 'ext-drawer-header', onClick: () => setOpen(false) }, '▼ Game Manager'),
      // Character Update
      React.createElement('section', null,
        React.createElement('h3', null, 'Character Update'),
        React.createElement('textarea', { rows: 6, defaultValue: data.card ?? '', id: 'gm-card-text' }),
        React.createElement('button', { onClick: () => applyCardUpdate(document.getElementById('gm-card-text').value) }, 'Update Card')
      ),
      // Lorebook Manager
      React.createElement('section', null,
        React.createElement('h3', null, 'Lorebook Manager'),
        React.createElement('textarea', { rows: 6, defaultValue: data.lore?.text ?? '', id: 'gm-lore-text' }),
        React.createElement('button', { onClick: () => applyLoreUpdate(data.lore?.id, document.getElementById('gm-lore-text').value) }, 'Update Entry')
      ),
      // First Message
      React.createElement('section', null,
        React.createElement('h3', null, 'Suggested First Message'),
        React.createElement('textarea', { rows: 4, defaultValue: data.firstMessage ?? '', id: 'gm-first-text' }),
        React.createElement('button', { onClick: generateFirstMessage }, 'Generate Suggestion'),
        React.createElement('button', null, 'Use as First Message')
      ),
      data.failures > 0 && React.createElement('div', { style: { color: 'red' } }, `⚠︎ optimiser failed ${data.failures} time(s) – raw prompt sent.`)
    )
  );
}

const rootEl = document.getElementById('game-manager-root');
if (rootEl) {
  const root = createRoot(rootEl);
  root.render(React.createElement(GameManagerDrawer));
}
