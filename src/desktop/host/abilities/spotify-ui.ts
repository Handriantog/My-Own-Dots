import {
  appCommandSchema,
  type AppCommand,
} from '../../../shared/abilities/app-control.js';
import { AbilityFailure } from '../../../shared/abilities/bridge.js';
import type {
  CapabilityReply,
  OwnerResult,
} from '../../../shared/abilities/protocol.js';

/** Private host adapter: never supplied by or returned to an Ability worker. */
export type SpotifyNode = {
  id: number;
  parent: number;
  role: string;
  label: string;
  value?: string;
  url?: string;
};
export type SpotifySurface = {
  snapshot(): Promise<SpotifyNode[]>;
  press(node: SpotifyNode): Promise<void>;
  menu(node: SpotifyNode): Promise<void>;
  set(node: SpotifyNode, value: string): Promise<void>;
  enter(node: SpotifyNode): Promise<void>;
  wait(): Promise<void>;
};
const fail = () => {
  throw new AbilityFailure('setup_needed');
};
function one(nodes: SpotifyNode[], predicate: (n: SpotifyNode) => boolean) {
  const matches = nodes.filter(predicate);
  if (matches.length !== 1) return fail();
  return matches[0]!;
}
function inside(nodes: SpotifyNode[], root: SpotifyNode) {
  const included = new Set([root.id]);
  // Native snapshots are preorder; tests and callers do not need that assumption.
  for (let i = 0; i < 48; i++) {
    const before = included.size;
    for (const n of nodes) if (included.has(n.parent)) included.add(n.id);
    if (included.size === before) break;
  }
  return nodes.filter((n) => included.has(n.id));
}
function resource(raw: string | undefined, kind: 'track' | 'playlist') {
  if (!raw) return;
  try {
    const url = new URL(
      raw.startsWith('xpui.app.spotify.com/') ? `https://${raw}` : raw,
    );
    if (
      url.protocol !== 'https:' ||
      !['xpui.app.spotify.com', 'open.spotify.com'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      return;
    const match = new RegExp(`^/${kind}/([A-Za-z0-9]{22})$`).exec(url.pathname);
    if (match)
      return {
        uri: `spotify:${kind}:${match[1]}`,
        url: `https://open.spotify.com/${kind}/${match[1]}`,
      };
  } catch {
    // An unreadable link cannot become a selectable resource.
  }
}
function searchItems(nodes: SpotifyNode[], kind: 'track' | 'playlist') {
  const table = one(
    nodes,
    (n) => n.role === 'AXTable' && n.label === 'Search results',
  );
  const rows = inside(nodes, table).filter((n) => n.role === 'AXRow');
  const seen = new Set<string>();
  const items: Extract<OwnerResult, { kind: 'list' }>['items'] = [];
  for (const row of rows) {
    const contents = inside(nodes, row);
    const links = contents.flatMap((n) => {
      const r = n.role === 'AXLink' ? resource(n.url, kind) : undefined;
      return r ? [{ ...r, node: n }] : [];
    });
    if (links.length !== 1) continue;
    const link = links[0]!;
    if (!link.node.label || seen.has(link.uri)) continue;
    seen.add(link.uri);
    const detail = contents
      .filter(
        (n) =>
          n.role === 'AXLink' &&
          n.id !== link.node.id &&
          !resource(n.url, 'track') &&
          !resource(n.url, 'playlist'),
      )
      .map((n) => n.label)
      .join(', ')
      .slice(0, 2000);
    items.push({
      label: link.node.label.slice(0, 1000),
      ...(detail ? { detail } : {}),
      url: link.url,
      action: { uri: link.uri },
    });
    if (items.length === 20) break;
  }
  return items;
}
export async function runSpotifyUI(
  command: AppCommand,
  surface: SpotifySurface,
  signal: AbortSignal,
): Promise<CapabilityReply> {
  let mutated = false;
  const check = () => {
    if (signal.aborted) throw new AbilityFailure('cancelled');
  };
  const snapshot = async () => {
    check();
    const nodes = await surface.snapshot();
    check();
    return nodes;
  };
  const press = async (n: SpotifyNode, mutation = false) => {
    check();
    if (mutation) mutated = true;
    await surface.press(n);
    check();
  };
  const success = (result?: OwnerResult): CapabilityReply => ({
    ok: true,
    kind: 'app-control',
    status: 'success',
    ...(result ? { result } : {}),
  });
  const waitFor = async <T>(
    read: (nodes: SpotifyNode[]) => T | undefined,
  ): Promise<T> => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = read(await snapshot());
      if (result !== undefined) return result;
      await surface.wait();
      check();
    }
    return fail();
  };
  try {
    check();
    if (!appCommandSchema.safeParse(command).success)
      return { ok: false, code: 'permission_denied' };
    const search = async (query: string) => {
      if (
        /(?:spotify\s*:|(?:https?:\/\/|www\.)|open\.spotify\.com|[\r\n])/i.test(
          query,
        )
      )
        throw new AbilityFailure('permission_denied');
      const field = one(
        await snapshot(),
        (n) =>
          n.role === 'AXComboBox' && n.label === 'What do you want to play?',
      );
      await surface.set(field, query);
      check();
      const fresh = one(
        await snapshot(),
        (n) =>
          n.role === 'AXComboBox' &&
          n.label === field.label &&
          n.value === query,
      );
      await surface.enter(fresh);
      check();
      return waitFor((nodes) => {
        const fields = nodes.filter(
          (n) => n.role === 'AXComboBox' && n.label === field.label,
        );
        if (fields.length !== 1 || fields[0]!.value !== query) return fail();
        const currentRoute = nodes.some((n) => {
          if (n.role !== 'AXLink' || n.label !== 'All' || !n.url) return false;
          try {
            const url = new URL(
              n.url.startsWith('xpui.') ? `https://${n.url}` : n.url,
            );
            return (
              url.hostname === 'xpui.app.spotify.com' &&
              decodeURIComponent(url.pathname) === `/search/${query}`
            );
          } catch {
            return false;
          }
        });
        return currentRoute &&
          nodes.some(
            (n) => n.role === 'AXTable' && n.label === 'Search results',
          )
          ? nodes
          : undefined;
      });
    };
    if (command.action === 'search')
      return success({
        kind: 'list',
        title: 'Spotify search results',
        items: searchItems(
          await search(command.query),
          command.category === 'tracks' ? 'track' : 'playlist',
        ),
        attribution: 'Spotify',
      });
    if (command.action === 'playlists') {
      let nodes = await snapshot();
      const collapsed = nodes.filter(
        (n) => n.role === 'AXButton' && n.label === 'Open Your Library',
      );
      if (collapsed.length === 1) {
        await press(collapsed[0]!);
        nodes = await snapshot();
      }
      const library = one(
        nodes,
        (n) =>
          ['AXTable', 'AXOutline'].includes(n.role) &&
          n.label === 'Your Library',
      );
      const items: Extract<OwnerResult, { kind: 'list' }>['items'] = [];
      for (const row of inside(nodes, library).filter(
        (n) => n.role === 'AXRow',
      )) {
        if (
          !row.label ||
          row.label === 'Liked Songs' ||
          row.label === 'Local Files'
        )
          continue;
        const labels = inside(nodes, row).filter(
          (n) =>
            n.role === 'AXButton' &&
            n.label.startsWith(row.label + ' ') &&
            n.label.includes('Playlist •'),
        );
        if (labels.length !== 1) continue;
        items.push({
          label: row.label.slice(0, 1000),
          detail: labels[0]!.label.slice(0, 2000),
          action: { playlistName: row.label },
        });
        if (items.length === 100) break;
      }
      return success({
        kind: 'list',
        title: 'Visible Spotify playlists',
        items,
        attribution: 'Spotify',
      });
    }
    if (command.action === 'add_to_playlist') {
      let nodes = await search(command.query);
      const table = one(
        nodes,
        (n) => n.role === 'AXTable' && n.label === 'Search results',
      );
      const row = one(
        inside(nodes, table),
        (n) =>
          n.role === 'AXRow' &&
          inside(nodes, n).some(
            (link) => resource(link.url, 'track')?.uri === command.trackUri,
          ),
      );
      const options = inside(nodes, row).filter(
        (n) =>
          n.role === 'AXPopUpButton' && n.label.startsWith('More options for '),
      );
      if (options.length === 1) await press(options[0]!);
      else if (options.length === 0) {
        check();
        await surface.menu(
          one(
            inside(nodes, row),
            (n) =>
              n.role === 'AXLink' &&
              resource(n.url, 'track')?.uri === command.trackUri,
          ),
        );
        check();
      } else return fail();
      nodes = await waitFor((nodes) =>
        nodes.some(
          (n) => n.role === 'AXMenuItem' && n.label === 'Add to playlist',
        )
          ? nodes
          : undefined,
      );
      await press(
        one(
          nodes,
          (n) => n.role === 'AXMenuItem' && n.label === 'Add to playlist',
        ),
      );
      nodes = await waitFor((nodes) =>
        nodes.some(
          (n) => n.role === 'AXTextField' && n.label === 'Find a playlist',
        )
          ? nodes
          : undefined,
      );
      await surface.set(
        one(
          nodes,
          (n) => n.role === 'AXTextField' && n.label === 'Find a playlist',
        ),
        command.playlistName,
      );
      check();
      let previousMenu: string | undefined;
      const choice = await waitFor((nodes) => {
        const fields = nodes.filter(
          (n) => n.role === 'AXTextField' && n.label === 'Find a playlist',
        );
        if (fields.length !== 1 || fields[0]!.value !== command.playlistName) {
          previousMenu = undefined;
          return;
        }
        let parent = nodes.find((n) => n.id === fields[0]!.parent);
        for (
          let depth = 0;
          parent && parent.role !== 'AXMenu' && depth < 48;
          depth++
        )
          parent = nodes.find((n) => n.id === parent!.parent);
        if (!parent || parent.role !== 'AXMenu') return fail();
        const items = inside(nodes, parent).filter(
          (n) => n.role === 'AXMenuItem',
        );
        const matches = items.filter((n) => n.label === command.playlistName);
        if (matches.length > 1) return fail();
        const fingerprint = JSON.stringify(
          items.map((n) => [n.role, n.label, n.value ?? '']),
        );
        const stable = previousMenu === fingerprint;
        previousMenu = fingerprint;
        return stable && matches.length === 1 ? matches[0] : undefined;
      });
      await press(choice, true);
      // Delivery alone is not proof of a library change. Success requires Spotify's receipt.
      await waitFor((nodes) =>
        nodes.some((n) => n.label === `Added to ${command.playlistName}`)
          ? true
          : undefined,
      );
      return success();
    }
    if (command.action === 'create_playlist') {
      let nodes = await snapshot();
      // A modal already open belongs to the owner, not this creation request.
      if (nodes.some((n) => n.label === 'Edit details')) return fail();
      const previous = new Set(
        nodes
          .filter(
            (n) => n.role === 'AXButton' && n.label.endsWith(' – Edit details'),
          )
          .map((n) => n.label),
      );
      await press(
        one(nodes, (n) => n.role === 'AXButton' && n.label === 'Create'),
      );
      nodes = await waitFor((nodes) =>
        nodes.some((n) => n.role === 'AXMenuItem' && n.label === 'Playlist')
          ? nodes
          : undefined,
      );
      await press(
        one(nodes, (n) => n.role === 'AXMenuItem' && n.label === 'Playlist'),
        true,
      );
      nodes = await waitFor((nodes) =>
        nodes.some(
          (n) =>
            (n.role === 'AXButton' &&
              n.label.endsWith(' – Edit details') &&
              !previous.has(n.label)) ||
            (n.role === 'AXTextField' && n.label === 'Name'),
        )
          ? nodes
          : undefined,
      );
      if (!nodes.some((n) => n.role === 'AXTextField' && n.label === 'Name')) {
        await press(
          one(
            nodes,
            (n) =>
              n.role === 'AXButton' &&
              n.label.endsWith(' – Edit details') &&
              !previous.has(n.label),
          ),
        );
        nodes = await waitFor((nodes) =>
          nodes.some((n) => n.role === 'AXTextField' && n.label === 'Name')
            ? nodes
            : undefined,
        );
      }
      let dialog = one(
        nodes,
        (n) =>
          n.label === 'Edit details' &&
          n.role !== 'AXHeading' &&
          n.role !== 'AXStaticText',
      );
      let scope = inside(nodes, dialog);
      if (
        scope.some((n) => n.role === 'AXButton' && n.label === 'Make private')
      ) {
        await press(
          one(
            scope,
            (n) => n.role === 'AXButton' && n.label === 'Make private',
          ),
          true,
        );
        nodes = await waitFor((nodes) =>
          nodes.some((n) => n.role === 'AXButton' && n.label === 'Make public')
            ? nodes
            : undefined,
        );
        dialog = one(
          nodes,
          (n) =>
            n.label === 'Edit details' &&
            n.role !== 'AXHeading' &&
            n.role !== 'AXStaticText',
        );
        scope = inside(nodes, dialog);
      }
      one(scope, (n) => n.role === 'AXButton' && n.label === 'Make public');
      await surface.set(
        one(scope, (n) => n.role === 'AXTextField' && n.label === 'Name'),
        command.name,
      );
      check();
      nodes = await snapshot();
      dialog = one(
        nodes,
        (n) =>
          n.label === 'Edit details' &&
          n.role !== 'AXHeading' &&
          n.role !== 'AXStaticText',
      );
      scope = inside(nodes, dialog);
      one(
        scope,
        (n) =>
          n.role === 'AXTextField' &&
          n.label === 'Name' &&
          n.value === command.name,
      );
      one(scope, (n) => n.role === 'AXButton' && n.label === 'Make public');
      await press(
        one(scope, (n) => n.role === 'AXButton' && n.label === 'Save'),
        true,
      );
      nodes = await waitFor((nodes) =>
        nodes.some((n) => n.label === `Make '${command.name}' private?`) ||
        nodes.some((n) => n.label === 'Private Playlist')
          ? nodes
          : undefined,
      );
      if (nodes.some((n) => n.label === `Make '${command.name}' private?`)) {
        const confirm = one(
          nodes,
          (n) =>
            n.label === `Make '${command.name}' private?` &&
            n.role !== 'AXHeading' &&
            n.role !== 'AXStaticText',
        );
        await press(
          one(
            inside(nodes, confirm),
            (n) => n.role === 'AXButton' && n.label === 'Make private',
          ),
          true,
        );
      }
      await waitFor((nodes) =>
        nodes.some((n) => n.label === 'Private Playlist') &&
        nodes.some(
          (n) =>
            n.role === 'AXButton' &&
            n.label === `${command.name} – Edit details`,
        )
          ? true
          : undefined,
      );
      return success({
        kind: 'text',
        text: 'Created a private playlist.',
        attribution: 'Spotify',
      });
    }
    if (command.action === 'save_current') {
      let nodes = await snapshot();
      const scope = inside(
        nodes,
        one(nodes, (n) => n.label === 'Now playing bar'),
      );
      const identity = scope.find((n) =>
        n.label.startsWith('Now playing:'),
      )?.label;
      if (
        scope.some(
          (n) => n.role === 'AXButton' && n.label === 'Remove from Liked Songs',
        )
      )
        return success();
      if (!identity) return fail();
      const sameTrack = (nodes: SpotifyNode[]) => {
        const scope = inside(
          nodes,
          one(nodes, (n) => n.label === 'Now playing bar'),
        );
        if (
          scope.find((n) => n.label.startsWith('Now playing:'))?.label !==
          identity
        )
          return fail();
        return scope;
      };
      if (
        scope.some(
          (n) => n.role === 'AXButton' && n.label === 'Add to Liked Songs',
        )
      ) {
        await press(
          one(
            scope,
            (n) => n.role === 'AXButton' && n.label === 'Add to Liked Songs',
          ),
          true,
        );
      } else {
        await press(
          one(
            scope,
            (n) => n.role === 'AXButton' && n.label === 'Add to playlist',
          ),
        );
        nodes = await waitFor((nodes) =>
          nodes.some(
            (n) => n.role === 'AXMenu' && n.label === 'Add to playlist menu',
          )
            ? nodes
            : undefined,
        );
        sameTrack(nodes);
        const menu = one(
          nodes,
          (n) => n.role === 'AXMenu' && n.label === 'Add to playlist menu',
        );
        const liked = one(
          inside(nodes, menu),
          (n) =>
            n.label === 'Liked Songs' && ['0', '1'].includes(n.value ?? ''),
        );
        if (liked.value === '1') {
          await press(
            one(nodes, (n) => n.role === 'AXButton' && n.label === 'Cancel'),
          );
          return success();
        }
        await press(liked, true);
        nodes = await waitFor((nodes) =>
          nodes.some((n) => n.label === 'Liked Songs' && n.value === '1')
            ? nodes
            : undefined,
        );
        sameTrack(nodes);
        await press(
          one(nodes, (n) => n.role === 'AXButton' && n.label === 'Done'),
          true,
        );
      }
      await waitFor((nodes) => {
        const current = sameTrack(nodes);
        return nodes.some((n) => n.label === 'Added to Liked Songs.') &&
          current.some(
            (n) =>
              n.role === 'AXButton' &&
              ['Add to playlist', 'Remove from Liked Songs'].includes(n.label),
          )
          ? true
          : undefined;
      });
      return success();
    }
    return { ok: false, code: 'setup_needed' };
  } catch (error) {
    return mutated
      ? { ok: true, kind: 'app-control', status: 'uncertain' }
      : {
          ok: false,
          code: error instanceof AbilityFailure ? error.code : 'setup_needed',
        };
  }
}
