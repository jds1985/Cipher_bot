// postinstall: make better-sqlite3 match the installed Electron so `npm ci` gives a runnable app.
// 1) electron-builder install-app-deps (tries prebuilt binaries, then compiles from source with node-gyp).
// 2) If that fails, explain what is missing (a C++ toolchain is needed when no prebuild exists for this Electron).
// Set CIPHER_SKIP_NATIVE_REBUILD=1 to skip (e.g. CI jobs that only type-check).
import { spawnSync } from 'node:child_process';

if (process.env.CIPHER_SKIP_NATIVE_REBUILD === '1') { console.log('[cipher] native rebuild skipped'); process.exit(0); }
const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const r = spawnSync(bin, ['electron-builder', 'install-app-deps'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status === 0) process.exit(0);
console.error(`
[cipher] Could not build better-sqlite3 for Electron.
  There is no prebuilt binary for this Electron version, so it must be compiled. Install a C++ toolchain, then run \`npm rebuild\`:
    Debian/Ubuntu: sudo apt install build-essential python3
    Fedora:        sudo dnf install gcc-c++ make python3
    macOS:         xcode-select --install
    Windows:       Visual Studio Build Tools ("Desktop development with C++")
`);
process.exit(r.status ?? 1);
