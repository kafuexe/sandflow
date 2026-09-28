// Electron main process: runs the Sandflow backend in-process and shows the UI in a window.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import electronUpdater from "electron-updater";
import { runAi } from "../backend/runners/ai";
import { runAuto } from "../backend/runners/auto";
import { startAppServer, type AppServer } from "../backend/server";

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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
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

function setupAutoUpdate() {
  if (!app.isPackaged) return;
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
  const appRoot = app.getAppPath();
  server = await startAppServer({
    dataDir: path.join(app.getPath("userData"), "data"),
    webRoot: path.join(appRoot, "dist"),
    bundledSkillsDir: app.isPackaged ? path.join(process.resourcesPath, "skills") : path.join(appRoot, "skills"),
    runners: { auto: runAuto, ai: runAi },
  });
  console.log(`Sandflow backend listening on ${server.url}`);
  createWindow(server.url);
  setupAutoUpdate();
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
