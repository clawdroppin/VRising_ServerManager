import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import { App } from './App';
import './index.css';

// Feel like a native app: no browser context menu or reload shortcuts.
window.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest('input, textarea, .cm-editor, .selectable')) e.preventDefault();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) e.preventDefault();
});

async function boot() {
  // Browser preview (npm run dev outside Tauri): install a fake backend so the UI is explorable.
  if (import.meta.env.DEV && !isTauri()) {
    (await import('./lib/devMock')).installDevMock();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
boot();
