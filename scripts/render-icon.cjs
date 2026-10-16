// Renders build/icon.svg to build/icon.png (1024px) — electron-builder makes the .ico and Linux icons from it.
// Run: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SIZE = 1024;
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  setTimeout(() => app.exit(1), 30_000);
  const root = path.join(__dirname, "..", "build");
  const svg = fs.readFileSync(path.join(root, "icon.svg"), "utf8");
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true });
  const html = `<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${SIZE}" height="${SIZE}" `)}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  fs.writeFileSync(path.join(root, "icon.png"), img.resize({ width: SIZE, height: SIZE }).toPNG());
  app.exit(0);
});
