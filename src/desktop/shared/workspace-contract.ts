/** The bundled renderer's complete native workspace boundary. No backend credentials. */
export interface WorkspaceDestination {
  dotId?: string;
  threadId?: string;
  spaceId?: string;
  pageId?: string;
}
export type WorkspaceCommand =
  'quick-navigation' | 'new-chat' | 'settings' | 'toggle-sidebar';
export interface WorkspaceStatus {
  phase: 'idle' | 'starting' | 'ready' | 'error' | 'stopped';
  message: string;
  warning?: string;
  stage?: 'workspace' | 'services' | 'backend' | 'ready';
}
export interface DesktopWorkspaceBridge {
  openWorkspace(destination?: WorkspaceDestination): Promise<void>;
  status(): Promise<WorkspaceStatus>;
  retry(): Promise<void>;
  chooseWorkspace(): Promise<boolean>;
  configure(values: Record<string, string>): Promise<void>;
  openPreferences(dotId?: string): Promise<void>;
  selectDesktopDot(dotId: string): Promise<void>;
  onCustomization(
    listener: (
      state: import('../../shared/dot-customization.js').DesktopDotState,
    ) => void,
  ): () => void;
  openBackendSettings(): Promise<void>;
  onNavigate(listener: (destination: WorkspaceDestination) => void): () => void;
  onCommand(listener: (command: WorkspaceCommand) => void): () => void;
  onStatus(listener: (status: WorkspaceStatus) => void): () => void;
}
