import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import { inTauri } from './ipc';

export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  if (!inTauri()) return window.prompt(title, defaultPath ?? 'D:\\VRisingServers\\Server');
  const r = await openDialog({ directory: true, title, defaultPath });
  return typeof r === 'string' ? r : null;
}

export async function pickFile(title: string, extensions: string[], name = 'Files'): Promise<string | null> {
  if (!inTauri()) return window.prompt(title, `C:\\Users\\me\\Downloads\\file.${extensions[0]}`);
  const r = await openDialog({ title, multiple: false, filters: [{ name, extensions }] });
  return typeof r === 'string' ? r : null;
}

export async function pickFiles(title: string, extensions: string[], name = 'Files'): Promise<string[]> {
  if (!inTauri()) {
    const p = window.prompt(title, `C:\\Users\\me\\Downloads\\world.${extensions[0]}`);
    return p ? [p] : [];
  }
  const r = await openDialog({ title, multiple: true, filters: [{ name, extensions }] });
  return Array.isArray(r) ? r : typeof r === 'string' ? [r] : [];
}

export async function pickSave(title: string, defaultPath: string, extensions: string[], name = 'Files'): Promise<string | null> {
  if (!inTauri()) return window.prompt(title, defaultPath);
  return (await saveDialog({ title, defaultPath, filters: [{ name, extensions }] })) ?? null;
}

export async function reveal(path: string) {
  if (!inTauri()) return console.info('open', path);
  await openPath(path);
}

export async function browse(url: string) {
  if (!inTauri()) {
    window.open(url, '_blank');
    return;
  }
  await openUrl(url);
}

export async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}
