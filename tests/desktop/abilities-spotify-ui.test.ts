import { describe, expect, it } from 'vitest';
import {
  runSpotifyUI,
  type SpotifySurface,
  type SpotifyNode,
} from '../../src/desktop/host/abilities/spotify-ui.js';
const node = (
  id: number,
  role: string,
  label: string,
  parent = 0,
  extra = {},
) => ({ id, role, label, parent, ...extra });
const track = 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA';
const search = [
  node(1, 'AXComboBox', 'What do you want to play?', 0, {
    value: 'Example Song',
  }),
  node(2, 'AXTable', 'Search results'),
  node(3, 'AXRow', 'Example Song', 2),
  node(4, 'AXLink', 'Example Song', 3, {
    url: 'https://xpui.app.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA',
  }),
  node(5, 'AXLink', 'Example Artist', 3, {
    url: 'https://xpui.app.spotify.com/artist/BBBBBBBBBBBBBBBBBBBBBB',
  }),
  node(6, 'AXPopUpButton', 'More options for Example Song', 3),
  node(7, 'AXLink', 'Wrong album', 3, {
    url: 'https://xpui.app.spotify.com/album/CCCCCCCCCCCCCCCCCCCCCC',
  }),
  node(8, 'AXLink', 'All', 0, {
    url: 'https://xpui.app.spotify.com/search/Example%20Song',
  }),
];
function surface(input: SpotifyNode[][]) {
  const states = structuredClone(input);
  let current = 0;
  const effects: Array<[string, number, string?]> = [];
  const driver: SpotifySurface = {
    menu: async (n) => {
      effects.push(['menu', n.id]);
      current = Math.min(current + 1, states.length - 1);
    },
    snapshot: async () => states[current]!,
    press: async (n) => {
      effects.push(['press', n.id]);
      current = Math.min(current + 1, states.length - 1);
    },
    set: async (n, v) => {
      effects.push(['set', n.id, v]);
      states[current] = states[current]!.map((node) =>
        node.id === n.id ? { ...node, value: v } : node,
      );
    },
    enter: async (n) => {
      effects.push(['enter', n.id]);
      current = Math.min(current + 1, states.length - 1);
    },
    wait: async () => {},
  };
  return { driver, effects };
}
describe('Spotify scoped UI workflows', () => {
  it('returns exact track links privately and does not turn albums into tracks', async () => {
    const { driver, effects } = surface([search, search]);
    const result = await runSpotifyUI(
      { action: 'search', query: 'Example Song', category: 'tracks' },
      driver,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      ok: true,
      status: 'success',
      result: {
        kind: 'list',
        items: [
          {
            label: 'Example Song',
            url: 'https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA',
            action: { uri: track },
          },
        ],
      },
    });
    expect(effects).toEqual([
      ['set', 1, 'Example Song'],
      ['enter', 1],
    ]);
  });
  it.each([
    'spotify:track:AAAAAAAAAAAAAAAAAAAAAA',
    'https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA',
  ])('rejects link searches before UI changes: %s', async (query) => {
    const { driver, effects } = surface([search]);
    expect(
      await runSpotifyUI(
        { action: 'search', query, category: 'tracks' },
        driver,
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, code: 'permission_denied' });
    expect(effects).toEqual([]);
  });
  it('scopes save to the now-playing bar despite other save buttons', async () => {
    const before = [
      node(1, 'AXGroup', 'Now playing bar'),
      node(2, 'AXGroup', 'Now playing: Example Song by Example Artist', 1),
      node(3, 'AXButton', 'Add to Liked Songs', 2),
      node(4, 'AXButton', 'Add to Liked Songs'),
    ];
    const after = [
      ...before.map((n) =>
        n.id === 3 ? { ...n, label: 'Add to playlist' } : n,
      ),
      node(9, 'AXStaticText', 'Added to Liked Songs.'),
    ];
    const { driver, effects } = surface([before, after]);
    expect(
      await runSpotifyUI(
        { action: 'save_current' },
        driver,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true, status: 'success' });
    expect(effects).toEqual([['press', 3]]);
  });
  it('does not toggle an already saved song off', async () => {
    const { driver, effects } = surface([
      [
        node(1, 'AXGroup', 'Now playing bar'),
        node(2, 'AXButton', 'Remove from Liked Songs', 1),
      ],
    ]);
    expect(
      await runSpotifyUI(
        { action: 'save_current' },
        driver,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true, status: 'success' });
    expect(effects).toEqual([]);
  });
  it('reports uncertain if current track changes after saving, without retry', async () => {
    const { driver, effects } = surface([
      [
        node(1, 'AXGroup', 'Now playing bar'),
        node(2, 'AXGroup', 'Now playing: One', 1),
        node(3, 'AXButton', 'Add to Liked Songs', 2),
      ],
      [
        node(1, 'AXGroup', 'Now playing bar'),
        node(2, 'AXGroup', 'Now playing: Two', 1),
        node(3, 'AXButton', 'Remove from Liked Songs', 2),
      ],
    ]);
    expect(
      await runSpotifyUI(
        { action: 'save_current' },
        driver,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true, status: 'uncertain' });
    expect(effects.filter((e) => e[0] === 'press')).toHaveLength(1);
  });
  it('does not act when cancelled', async () => {
    const { driver, effects } = surface([search]);
    const abort = new AbortController();
    abort.abort();
    expect(
      await runSpotifyUI({ action: 'save_current' }, driver, abort.signal),
    ).toEqual({ ok: false, code: 'cancelled' });
    expect(effects).toEqual([]);
  });
});

const library = [
  node(1, 'AXTable', 'Your Library'),
  node(2, 'AXRow', 'Example playlist', 1),
  node(3, 'AXButton', 'Example playlist Playlist • Owner', 2),
  node(4, 'AXRow', 'An album', 1),
  node(5, 'AXButton', 'An album Album • Artist', 4),
];
describe('Spotify playlist workflows', () => {
  it('lists library playlists without exposing unrelated album choices', async () => {
    const { driver, effects } = surface([library]);
    expect(
      await runSpotifyUI(
        { action: 'playlists' },
        driver,
        new AbortController().signal,
      ),
    ).toMatchObject({
      ok: true,
      result: {
        kind: 'list',
        items: [
          {
            label: 'Example playlist',
            action: { playlistName: 'Example playlist' },
          },
        ],
      },
    });
    expect(effects).toEqual([]);
  });
  it('rejects a stale search page rather than returning unrelated results', async () => {
    const old = search.map((n) =>
      n.id === 8
        ? { ...n, url: 'https://xpui.app.spotify.com/search/Other' }
        : n,
    );
    const { driver } = surface([old]);
    expect(
      await runSpotifyUI(
        { action: 'search', query: 'Example Song', category: 'tracks' },
        driver,
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, code: 'setup_needed' });
  });
  it('never clicks duplicate playlist names in the add menu', async () => {
    const menu = [
      node(10, 'AXMenu', ''),
      node(11, 'AXMenuItem', 'Add to playlist', 10),
    ];
    const picker = [
      node(10, 'AXMenu', ''),
      node(12, 'AXMenu', '', 10),
      node(13, 'AXTextField', 'Find a playlist', 12),
      node(14, 'AXMenuItem', 'Example playlist', 12),
      node(15, 'AXMenuItem', 'Example playlist', 12),
    ];
    const { driver, effects } = surface([search, search, menu, picker]);
    expect(
      await runSpotifyUI(
        {
          action: 'add_to_playlist',
          query: 'Example Song',
          trackUri: track,
          playlistName: 'Example playlist',
        },
        driver,
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, code: 'setup_needed' });
    expect(effects.filter((e) => e[0] === 'press').map((e) => e[1])).toEqual([
      6, 11,
    ]);
  });
  it('does not add a different recording if the selected track vanishes', async () => {
    const { driver, effects } = surface([search]);
    expect(
      await runSpotifyUI(
        {
          action: 'add_to_playlist',
          query: 'Example Song',
          trackUri: 'spotify:track:ZZZZZZZZZZZZZZZZZZZZZZ',
          playlistName: 'Example playlist',
        },
        driver,
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, code: 'setup_needed' });
    expect(effects.filter((e) => e[0] === 'press')).toEqual([]);
  });
});
describe('playlist creation privacy', () => {
  const initial = [node(1, 'AXButton', 'Create')];
  const menu = [node(2, 'AXMenu', ''), node(3, 'AXMenuItem', 'Playlist', 2)];
  const page = [
    node(4, 'AXButton', 'My Playlist #99 – Edit details'),
    node(5, 'AXStaticText', 'Public Playlist'),
  ];
  const dialog = [
    node(6, 'AXGroup', 'Edit details'),
    node(7, 'AXTextField', 'Name', 6, { value: 'My Playlist #99' }),
    node(8, 'AXButton', 'Make private', 6),
    node(9, 'AXButton', 'Save', 6),
  ];
  it('makes the new playlist private before naming and saving it', async () => {
    const privateDialog = dialog.map((n) =>
      n.id === 8 ? { ...n, label: 'Make public' } : n,
    );
    const { driver, effects } = surface([
      initial,
      menu,
      page,
      dialog,
      privateDialog,
      [
        node(12, 'AXGroup', "Make 'Dot test' private?"),
        node(13, 'AXButton', 'Make private', 12),
      ],
      [
        node(10, 'AXStaticText', 'Private Playlist'),
        node(11, 'AXButton', 'Dot test – Edit details'),
      ],
    ]);
    expect(
      await runSpotifyUI(
        { action: 'create_playlist', name: 'Dot test' },
        driver,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true, status: 'success' });
    expect(effects).toEqual([
      ['press', 1],
      ['press', 3],
      ['press', 4],
      ['press', 8],
      ['set', 7, 'Dot test'],
      ['press', 9],
      ['press', 13],
    ]);
  });
  it('reports uncertainty without naming the playlist when privacy is not confirmed', async () => {
    const { driver, effects } = surface([initial, menu, page, dialog, dialog]);
    expect(
      await runSpotifyUI(
        { action: 'create_playlist', name: 'Private name' },
        driver,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true, status: 'uncertain' });
    expect(effects.some((e) => e[0] === 'set')).toBe(false);
    expect(effects.filter((e) => e[1] === 3)).toHaveLength(1);
  });
});
it('checks Liked Songs membership when the current song is already in a playlist', async () => {
  const bar = [
    node(1, 'AXGroup', 'Now playing bar'),
    node(2, 'AXGroup', 'Now playing: Test', 1),
    node(3, 'AXButton', 'Add to playlist', 2),
  ];
  const menu = [
    ...bar,
    node(4, 'AXMenu', 'Add to playlist menu'),
    node(5, 'AXMenuItem', 'Liked Songs', 4, { value: '1' }),
    node(6, 'AXButton', 'Cancel'),
  ];
  const { driver, effects } = surface([bar, menu, bar]);
  expect(
    await runSpotifyUI(
      { action: 'save_current' },
      driver,
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: true, status: 'success' });
  expect(effects).toEqual([
    ['press', 3],
    ['press', 6],
  ]);
});
it('opens the exact track link context menu when responsive layout hides More options', async () => {
  const menu = [
    node(10, 'AXMenu', ''),
    node(11, 'AXMenuItem', 'Add to playlist', 10),
  ];
  const picker = [
    node(12, 'AXMenu', ''),
    node(13, 'AXTextField', 'Find a playlist', 12),
    node(14, 'AXMenuItem', 'Example playlist', 12),
  ];
  const { driver, effects } = surface([
    search.filter((n) => n.id !== 6),
    search.filter((n) => n.id !== 6),
    menu,
    picker,
    [node(20, 'AXStaticText', 'Added to Example playlist')],
  ]);
  expect(
    await runSpotifyUI(
      {
        action: 'add_to_playlist',
        query: 'Example Song',
        trackUri: track,
        playlistName: 'Example playlist',
      },
      driver,
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: true, status: 'success' });
  expect(effects.filter((e) => e[0] === 'menu' || e[0] === 'press')).toEqual([
    ['menu', 4],
    ['press', 11],
    ['press', 14],
  ]);
});

it('waits for the filtered destination menu to settle before using its fresh handle', async () => {
  const menu = [
    node(10, 'AXMenu', ''),
    node(11, 'AXMenuItem', 'Add to playlist', 10),
  ];
  const picker = [
    node(12, 'AXMenu', ''),
    node(13, 'AXTextField', 'Find a playlist', 12),
    node(14, 'AXMenuItem', 'Example playlist', 12),
  ];
  const fixture = surface([
    search,
    search,
    menu,
    picker,
    [node(20, 'AXStaticText', 'Added to Example playlist')],
  ]);
  let settled = false;
  const original = fixture.driver.snapshot,
    press = fixture.driver.press;
  fixture.driver.snapshot = async () =>
    (await original()).map((n) =>
      settled && n.id === 14 ? { ...n, id: 24 } : n,
    );
  fixture.driver.wait = async () => {
    settled = true;
  };
  fixture.driver.press = async (n) => {
    if (n.id === 14) throw Error('Spotify replaced the filtered row');
    await press(n);
  };
  expect(
    await runSpotifyUI(
      {
        action: 'add_to_playlist',
        query: 'Example Song',
        trackUri: track,
        playlistName: 'Example playlist',
      },
      fixture.driver,
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: true, status: 'success' });
  expect(
    fixture.effects.filter((e) => e[0] === 'press').map((e) => e[1]),
  ).toEqual([6, 11, 24]);
});
