/** Native helpers exposed by the desktop app's preload (undefined when running in a browser). */
export interface SandflowDesktop {
  pickFile(title: string, extensions: string[]): Promise<string | null>;
  pickFolder(title: string): Promise<string | null>;
  version(): Promise<string>;
}

export const desktop = (globalThis as { sandflowDesktop?: SandflowDesktop }).sandflowDesktop;
