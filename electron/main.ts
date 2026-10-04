// Electron main process: runs the Sandflow backend in-process and shows the UI in a window.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import electronUpdater from "electron-updater";
import { runAi } from "../backend/runners/ai";
import { runAuto } from "../backend/runners/auto";
import { runScript } from "../backend/runners/script";
import { startAppServer, type AppServer } from "../backend/server";
import type { UpdateSettings } from "../shared/types";

const { autoUpdater } = electronUpdater;

let server: AppServer | undefined;
let win: BrowserWindow | undefined;
let quitting = false;

/**
 * Apps started from Finder / a desktop launcher get a minimal PATH, so git, docker, gh and the agent
 * CLIs wouldn't be found. Take PATH from the user's login shell instead.
 */
function loadShellPath() {
  if (process.platform === "win32") return;
  try {
    const sh = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    const out = execFileSync(sh, ["-ilc", 'printf "__SANDFLOW_PATH__%s" "$PATH"'], { encoding: "utf8", timeout: 5000 });
    const p = out.split("__SANDFLOW_PATH__")[1]?.trim();
    if (p) process.env.PATH = p;
  } catch {
    /* keep the inherited PATH */
  }
}

function createWindow(url: string) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: "Sandflow",
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(import.meta.dirname, "preload.cjs"),
    },
  });
  // Links (skill docs etc.) open in the real browser; the window never navigates away from the app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (!target.startsWith(url)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    }
  });
  win.on("closed", () => (win = undefined));
  void win.loadURL(url);
}

/** Native pickers for the UI (see preload.ts) — the web UI can't learn local file paths otherwise. */
function registerIpc() {
  ipcMain.handle("sandflow:pick-file", async (_e, title: string, extensions: string[]) => {
    const r = await dialog.showOpenDialog(win!, {
      title,
      properties: ["openFile"],
      filters: [{ name: title, extensions }, { name: "All files", extensions: ["*"] }],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle("sandflow:pick-folder", async (_e, title: string) => {
    const r = await dialog.showOpenDialog(win!, { title, properties: ["openDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle("sandflow:version", () => app.getVersion());
}

/** Settings → Updates: GitHub releases (default), an internal URL (air-gapped), or off. */
function readUpdateSettings(dataDir: string): UpdateSettings {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")) as { updates?: UpdateSettings };
    return s.updates ?? { mode: "github" };
  } catch {
    return { mode: "github" };
  }
}

function setupAutoUpdate(dataDir: string) {
  if (!app.isPackaged) return;
  const cfg = readUpdateSettings(dataDir);
  if (cfg.mode === "off") return console.log("[update] disabled in settings");
  if (cfg.mode === "url" && cfg.url) autoUpdater.setFeedURL({ provider: "generic", url: cfg.url });
  autoUpdater.on("error", (e) => console.warn("[update]", e.message));
  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Sandflow ${info.version} is ready to install`,
      detail: "Restart to update. Any running flow will be cancelled. Otherwise it installs the next time you quit.",
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  void autoUpdater.checkForUpdates().catch((e: Error) => console.warn("[update]", e.message));
}

async function start() {
  loadShellPath();
  registerIpc();
  const appRoot = app.getAppPath();
  const dataDir = path.join(app.getPath("userData"), "data");
  server = await startAppServer({
    dataDir,
    webRoot: path.join(appRoot, "dist"),
    bundledSkillsDir: app.isPackaged ? path.join(process.resourcesPath, "skills") : path.join(appRoot, "skills"),
    bundledPacksDir: app.isPackaged ? path.join(process.resourcesPath, "packs") : path.join(appRoot, "packs"),
    runners: { auto: runAuto, ai: runAi, script: runScript },
  });
  console.log(`Sandflow backend listening on ${server.url}`);
  createWindow(server.url);
  setupAutoUpdate(dataDir);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(start, (e: Error) => {
    dialog.showErrorBox("Sandflow failed to start", e.message);
    app.exit(1);
  });
  app.on("window-all-closed", () => app.quit());
  // Cancel active runs first so sandboxes / containers are torn down, then really quit.
  app.on("before-quit", (e) => {
    if (quitting || !server) return;
    e.preventDefault();
    quitting = true;
    void server.close().finally(() => app.quit());
  });
}
