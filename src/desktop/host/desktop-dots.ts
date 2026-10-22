import {
  customizationFromPreferences,
  desktopDotSchema,
  type DesktopDotState,
  type DotCustomization,
} from '../../shared/dot-customization.js';
import type { WorkspaceProtocolConnection } from './workspace-protocol.js';

/** Serializes native reads and writes against the active workspace. */
export class DesktopDots {
  private state?: DesktopDotState;
  private connection?: WorkspaceProtocolConnection;
  private pending: Promise<unknown> = Promise.resolve();
  private syncing?: Promise<DesktopDotState | undefined>;
  private legacy: DotCustomization;
  constructor(
    private readonly getConnection: () =>
      WorkspaceProtocolConnection | undefined,
    preferences: DotCustomization,
    private readonly changed: (state: DesktopDotState | undefined) => void,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.legacy = customizationFromPreferences(preferences);
  }

  get current() {
    return this.connection === this.getConnection() ? this.state : undefined;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => {}).then(operation);
    this.pending = result;
    return result;
  }
  private async request(
    connection: WorkspaceProtocolConnection,
    path: string,
    method = 'GET',
    body?: unknown,
  ) {
    if (connection !== this.getConnection())
      throw new Error('The workspace changed. Reopen Dot settings.');
    const response = await this.fetcher(
      new URL(`/api/${path}`, connection.url),
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(connection.ownerToken
            ? { authorization: `Bearer ${connection.ownerToken}` }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok)
      throw new Error('Could not save or load this Dot. Try again.');
    const state = desktopDotSchema.parse(await response.json());
    if (connection !== this.getConnection())
      throw new Error('The workspace changed. Reopen Dot settings.');
    return state;
  }
  private accept(
    connection: WorkspaceProtocolConnection,
    state: DesktopDotState,
  ) {
    const changed =
      this.connection !== connection ||
      JSON.stringify(this.state) !== JSON.stringify(state);
    this.connection = connection;
    this.state = state;
    if (changed) this.changed(state);
    return state;
  }
  sync(): Promise<DesktopDotState | undefined> {
    return (this.syncing ??= this.enqueue(async () => {
      const connection = this.getConnection();
      if (!connection) {
        if (this.state) {
          this.state = undefined;
          this.connection = undefined;
          this.changed(undefined);
        }
        return undefined;
      }
      let state = await this.request(connection, 'desktop-dot');
      if (!state.initialized)
        state = await this.request(
          connection,
          'desktop-dot/initialize',
          'POST',
          this.legacy,
        );
      return this.accept(connection, state);
    }).finally(() => {
      this.syncing = undefined;
    }));
  }
  select(dotId: string) {
    return this.mutate('desktop-dot', 'PUT', { dotId });
  }
  update(dotId: string, change: Partial<DotCustomization>) {
    return this.mutate(
      `dots/${encodeURIComponent(dotId)}/customization`,
      'PATCH',
      change,
    );
  }
  private mutate(path: string, method: string, body: unknown) {
    const connection = this.getConnection();
    return this.enqueue(async () => {
      if (!connection)
        throw new Error('Open your workspace before customizing a Dot.');
      return this.accept(
        connection,
        await this.request(connection, path, method, body),
      );
    });
  }
}
