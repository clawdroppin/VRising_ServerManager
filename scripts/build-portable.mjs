// Builds the portable edition: release/VRising-Server-Manager-Portable-<version>/ + a .zip of it.
// The folder contains the app exe and a `portable.txt` marker; on first launch the app creates
// `data/` next to itself and keeps everything there (settings, servers, SteamCMD, backups, WebView2 profile).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const exe = join(root, 'src-tauri', 'target', 'release', 'vrising-server-manager.exe');

if (!process.argv.includes('--skip-build')) {
  console.log('› Building release binary (no installer)…');
  execSync('npx tauri build --no-bundle', { cwd: root, stdio: 'inherit' });
}
if (!existsSync(exe)) throw new Error(`Release binary not found at ${exe}`);

const name = `VRising-Server-Manager-Portable-${version}`;
const outDir = join(root, 'release', name);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

cpSync(exe, join(outDir, 'V Rising Server Manager.exe'));
writeFileSync(
  join(outDir, 'portable.txt'),
  [
    'This file switches V Rising Server Manager into PORTABLE mode.',
    '',
    'While it sits next to "V Rising Server Manager.exe", all app data is kept in the "data" folder here:',
    'settings, server profiles, SteamCMD, default server installs, backups and the browser cache.',
    'You can move or copy this whole folder (e.g. to another drive) - stored paths are fixed up automatically.',
    '',
    'Delete this file to make the exe use your user profile (%APPDATA%) instead.',
    '',
  ].join('\r\n'),
);
writeFileSync(
  join(outDir, 'README.txt'),
  [
    `V Rising Server Manager ${version} - portable edition`,
    '',
    'Run "V Rising Server Manager.exe". No installation needed.',
    'Requires the Microsoft Edge WebView2 runtime, which ships with Windows 10 and 11.',
    'Put the folder somewhere you can write to (not inside Program Files).',
    '',
  ].join('\r\n'),
);

const zip = join(root, 'release', `${name}.zip`);
rmSync(zip, { force: true });
console.log('› Zipping…');
execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${outDir}' -DestinationPath '${zip}' -Force"`, { stdio: 'inherit' });
console.log(`✓ Portable build ready:\n  ${outDir}\n  ${zip}`);
