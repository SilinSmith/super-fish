// Fallback injector for SnowLuma: loads the hook DLL into the QQ process that
// owns the bot account database. Used only when SnowLuma's own UIN
// auto-detection fails to bring up the OneBot ports.
//
// Usage: node snowluma-inject.mjs
// Exit:  0 injected / already hooked, 1 failure, 2 no safe QQ process found.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const ADDON_PATH = process.env.SNOWLUMA_ADDON || 'Y:/SnowLuma/native/snowluma-win32-x64.node';
const DLL_PATH = process.env.SNOWLUMA_DLL || 'Y:/SnowLuma/native/snowluma-win32-x64.dll';
const INI_PATH = 'C:/Users/Public/Documents/Tencent/QQ/UserDataInfo.ini';
const FALLBACK_ROOT = process.env.QQ_USERDATA_ROOT || 'Y:/Documents/Tencent Files';

function log(message) {
  console.log('[inject] ' + message);
}

function readDataRoot() {
  try {
    const text = fs.readFileSync(INI_PATH, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const match = /^\s*UserDataSavePath\s*=\s*(.+)$/i.exec(raw);
      if (!match) continue;
      const value = match[1].trim();
      if (value.length === 0) break;
      if (path.win32.basename(value).toLowerCase() === 'tencent files') return value;
      return path.win32.join(value, 'Tencent Files');
    }
  } catch (error) {
    log('cannot read ' + INI_PATH + ': ' + error.message);
  }
  return FALLBACK_ROOT;
}

function botUins() {
  const raw = process.env.SNOWLUMA_HOOK_AUTOLOAD_UINS || '10001';
  return raw.split(',').map((value) => value.trim()).filter((value) => /^\d+$/.test(value));
}

// The DLL already creates a named pipe once injected; injecting twice is
// pointless and can disturb a live session.
function alreadyHooked(pid) {
  try {
    const script =
      "if ([System.IO.Directory]::GetFiles('\\\\.\\pipe\\') -match 'mojo\\." +
      pid +
      "\\.control') { 'yes' } else { 'no' }";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true
    });
    return out.trim() === 'yes';
  } catch {
    return false;
  }
}

async function main() {
  if (!fs.existsSync(DLL_PATH)) {
    log('hook DLL missing: ' + DLL_PATH);
    process.exitCode = 1;
    return;
  }
  const addon = require(ADDON_PATH);
  const root = readDataRoot();
  log('data root: ' + root);

  const mains = await addon.getAllMainProcessAsync();
  const mainSet = new Set(mains);
  log('QQ main pids: ' + mains.join(','));

  let target = null;
  for (const uin of botUins()) {
    const dbPath = path.win32.join(root, uin, 'nt_qq', 'nt_db', 'nt_msg.db');
    try {
      const holders = await addon.getFileHoldersAsync(dbPath);
      const holder = holders.find((item) => mainSet.has(item.pid));
      if (holder) {
        target = holder.pid;
        log('UIN ' + uin + ' -> PID ' + holder.pid);
        break;
      }
      log('UIN ' + uin + ': no matching holder');
    } catch (error) {
      log('UIN ' + uin + ' probe failed: ' + error.message);
    }
  }

  if (target === null && mains.length === 1) {
    target = mains[0];
    log('no holder match; only one QQ main process, using PID ' + target);
  }
  if (target === null) {
    log('cannot pick a safe QQ process; open SnowLuma WebUI and load manually');
    process.exitCode = 2;
    return;
  }

  if (alreadyHooked(target)) {
    log('PID ' + target + ' already has the hook; nothing to do');
    return;
  }

  log('injecting hook into PID ' + target + ' ...');
  const handle = await addon.loadModuleManualAsync(target, DLL_PATH);
  log('injected: ' + JSON.stringify(handle, (_key, value) => (typeof value === 'bigint' ? String(value) : value)));
}

main().catch((error) => {
  log('ERROR ' + (error && error.stack ? error.stack : String(error)));
  process.exitCode = 1;
});
