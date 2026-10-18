/** Selection only. Workspace approval is required before a Dot receives access. */
export interface DesktopFolderBridge {
  choose(): Promise<{ path: string } | null>;
}
