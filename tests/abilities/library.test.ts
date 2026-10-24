import { describe, expect, it, vi } from 'vitest';
import { GitHubAbilityLibrary } from '../../src/desktop/host/abilities/library.ts';
const sha = 'a'.repeat(40);
const index = {
  catalogVersion: 1,
  abilities: [
    {
      id: 'spotify-local',
      name: 'Spotify Local',
      path: 'abilities/spotify-local',
      status: 'development',
      version: null,
      license: 'MIT',
    },
    {
      id: 'player',
      name: 'Player',
      path: 'abilities/player',
      status: 'released',
      version: '1.2.3',
      license: 'MIT',
    },
  ],
};
const file = (text: string) =>
  Buffer.from(
    JSON.stringify({
      type: 'file',
      encoding: 'base64',
      size: Buffer.byteLength(text),
      content: Buffer.from(text).toString('base64'),
    }),
  );
function fixture(catalog: unknown = index) {
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('/git/ref/heads/main')
      ? Buffer.from(JSON.stringify({ object: { type: 'commit', sha } }))
      : url.includes('/catalog.json?')
        ? file(JSON.stringify(catalog))
        : file('# Spotify\n\n**Play** music.'),
  );
  return { fetch, library: new GitHubAbilityLibrary(fetch) };
}
describe('GitHub Ability discovery', () => {
  it('pins catalog and README reads, exposes only released install proposals, and caches list reads', async () => {
    const { library, fetch } = fixture();
    const first = await library.browse(false, new AbortController().signal);
    expect(first.sourceCommit).toBe(sha);
    expect(first.entries[0]).toMatchObject({
      id: 'spotify-local',
      status: 'development',
    });
    expect(first.entries[0].descriptorUrl).toBeUndefined();
    expect(first.entries[1].descriptorUrl).toBe(
      'https://github.com/Handriantog/My-Own-Dot-Abilities/releases/download/player%2Fv1.2.3/player-1.2.3.json',
    );
    expect(await library.browse(false, new AbortController().signal)).toEqual(
      first,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      await library.documentation(
        'spotify-local',
        sha,
        new AbortController().signal,
      ),
    ).toBe('# Spotify\n\n**Play** music.');
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(
      `https://api.github.com/repos/Handriantog/My-Own-Dot-Abilities/contents/abilities/spotify-local/README.md?ref=${sha}`,
    );
    await library.browse(true, new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it.each([
    { ...index, abilities: [index.abilities[0], index.abilities[0]] },
    { ...index, abilities: [{ ...index.abilities[0], path: '../private' }] },
    { ...index, abilities: [{ ...index.abilities[0], status: 'released' }] },
    { ...index, abilities: [{ ...index.abilities[0], id: '../spotify' }] },
  ])('rejects malformed catalog authority fields', async (catalog) => {
    await expect(
      fixture(catalog).library.browse(false, new AbortController().signal),
    ).rejects.toThrow();
  });
  it('does not cache failure or accept renderer-controlled paths and revisions', async () => {
    const { library, fetch } = fixture();
    fetch.mockRejectedValueOnce(Error('offline'));
    await expect(
      library.browse(false, new AbortController().signal),
    ).rejects.toThrow();
    expect(
      (await library.browse(false, new AbortController().signal)).entries,
    ).toHaveLength(2);
    const count = fetch.mock.calls.length;
    for (const [id, ref] of [
      ['../secrets', sha],
      ['spotify-local', 'main?bad=1'],
    ])
      await expect(
        library.documentation(id, ref, new AbortController().signal),
      ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(count);
  });
  it('rejects oversized or malformed content without using download_url', async () => {
    const { library, fetch } = fixture();
    fetch.mockResolvedValueOnce(file('x'.repeat(70000)));
    await expect(
      library.documentation('player', sha, new AbortController().signal),
    ).rejects.toThrow();
    fetch.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          type: 'symlink',
          download_url: 'http://127.0.0.1/private',
        }),
      ),
    );
    await expect(
      library.documentation('player', sha, new AbortController().signal),
    ).rejects.toThrow();
  });
});

it('resolves the collection revision without downloading potentially large commit diffs', async () => {
  const { fetch, library } = fixture();
  fetch.mockImplementation(async (url) => {
    if (url.endsWith('/commits/main'))
      throw Error('Latest commit diff exceeds response limit');
    if (url.endsWith('/git/ref/heads/main'))
      return Buffer.from(JSON.stringify({ object: { type: 'commit', sha } }));
    return file(JSON.stringify(index));
  });
  expect(
    (await library.browse(false, new AbortController().signal)).sourceCommit,
  ).toBe(sha);
  expect(fetch.mock.calls[0][0]).toMatch(/\/git\/ref\/heads\/main$/);
});

it('propagates publisher icon metadata from the pinned catalog', async () => {
  const icon = {
    background: '#112233',
    foreground: '#ffffff',
    paths: ['M2 2H22V22H2Z'],
  };
  const { library } = fixture({
    ...index,
    abilities: [{ ...index.abilities[0], icon }],
  });
  expect(
    (await library.browse(false, new AbortController().signal)).entries[0],
  ).toMatchObject({ icon });
});

it('rejects unsafe catalog artwork before exposing an entry', async () => {
  const { library } = fixture({
    ...index,
    abilities: [
      {
        ...index.abilities[0],
        icon: {
          background: '#112233',
          foreground: '#ffffff',
          paths: ['<script>'],
        },
      },
    ],
  });
  await expect(
    library.browse(false, new AbortController().signal),
  ).rejects.toThrow();
});
