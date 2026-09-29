// Exposes the few native helpers the UI can use when running inside the desktop app.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sandflowDesktop", {
  pickFile: (title: string, extensions: string[]): Promise<string | null> =>
    ipcRenderer.invoke("sandflow:pick-file", title, extensions),
  pickFolder: (title: string): Promise<string | null> => ipcRenderer.invoke("sandflow:pick-folder", title),
  version: (): Promise<string> => ipcRenderer.invoke("sandflow:version"),
});
