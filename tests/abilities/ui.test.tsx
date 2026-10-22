import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbilitiesSection } from '../../src/client/abilities/AbilitiesSection.tsx';
import { PermissionReview } from '../../src/client/abilities/PermissionReview.tsx';
import {
  AbilityResultCard,
  OwnerResultView,
} from '../../src/client/abilities/AbilityResultCard.tsx';
import { parseManifest } from '../../src/shared/abilities/manifest.ts';
import type { DesktopAbilities } from '../../src/shared/abilities/desktop.ts';
import manifestFixture from '../fixtures/abilities/manifest.json';
let root: ReactTestRenderer;
const manifest = parseManifest(manifestFixture);
const binding = {
  id: randomUUID(),
  dotId: 'dot-a',
  manifest,
  digest: 'a'.repeat(64),
  grants: ['account', 'search'],
  settings: {},
  revision: 1,
  enabled: true,
  restored: false,
  approvedAt: 1,
};
const review = {
  id: randomUUID(),
  descriptor: {
    formatVersion: 1 as const,
    manifest,
    sourceCommit: 'b'.repeat(40),
    releaseTag: 'fixture/v0.1.0',
    asset: {
      id: 1,
      name: 'fixture.tar.gz',
      sha256: binding.digest,
      compressedBytes: 100,
      extractedBytes: 200,
      fileCount: 2,
    },
  },
  descriptorUrl:
    'https://github.com/example/abilities/releases/download/fixture/fixture.json',
  archiveUrl:
    'https://github.com/example/abilities/releases/download/fixture/fixture.tar.gz',
  descriptorSha256: 'c'.repeat(64),
  expiresAt: Date.now() + 300000,
  changes: [],
};
function bridge() {
  const api = {
    list: vi.fn(async () => ({
      ok: true,
      value: {
        available: true,
        bindings: [] as (typeof binding)[],
        activity: {},
      },
    })),
    review: vi.fn(async () => ({ ok: true, value: review })),
    teach: vi.fn(async () => ({ ok: true, value: binding })),
    update: vi.fn(async () => ({ ok: true, value: binding })),
    account: vi.fn(async () => ({ ok: true, value: { connected: false } })),
    configure: vi.fn(async () => ({ ok: true, value: binding })),
    connect: vi.fn(async () => ({ ok: true, value: { ok: true } })),
    results: vi.fn(async () => ({
      ok: true,
      value: {
        kind: 'text',
        text: 'SPOTIFY_SENTINEL<script>alert(1)</script>',
      },
    })),
    select: vi.fn(async () => ({
      ok: true,
      value: { selectionRef: randomUUID() },
    })),
  };
  vi.stubGlobal('window', { dotAbilities: api as unknown as DesktopAbilities });
  return api;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const text = () => JSON.stringify(root.toJSON());
async function mount() {
  await act(async () => {
    root = create(<AbilitiesSection dotId="dot-a" dotName="Mochi" />);
  });
}
const button = (label: string) =>
  root.root
    .findAllByType('button')
    .find((item) => item.children.join('') === label)!;
describe('teach and manage Abilities', () => {
  it('shows source, selected Dot, pinned version, runtime and actual access before Teach', async () => {
    bridge();
    await act(async () => {
      root = create(
        <PermissionReview
          dotName="Mochi"
          review={review}
          onTeach={async () => {}}
          onCancel={() => {}}
        />,
      );
    });
    for (const value of [
      'Mochi',
      'example/abilities',
      manifest.version,
      'JavaScript',
      'GET',
      'api.example.com',
      'read-items',
    ])
      expect(text()).toContain(value);
    expect(button('Teach')).toBeDefined();
    expect(
      root.root
        .findAllByType('button')
        .every((item) => item.props.type === 'button'),
    ).toBe(true);
  });
  it('does not install before consent; prevents double submits and preserves the URL after failure', async () => {
    const api = bridge();
    await mount();
    const input = root.root.findByProps({
      'aria-label': 'GitHub release descriptor',
    });
    await act(async () => {
      input.props.onChange({ target: { value: review.descriptorUrl } });
    });
    let release = () => {};
    api.review.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, value: review });
        }),
    );
    await act(async () => {
      void button('Review').props.onClick();
      void button('Review').props.onClick();
    });
    expect(api.review).toHaveBeenCalledTimes(1);
    expect(api.teach).not.toHaveBeenCalled();
    await act(async () => {
      release();
    });
    expect(text()).toContain('Mochi');
    api.teach.mockResolvedValueOnce({
      ok: false,
      code: 'invalid_response',
    } as never);
    await act(async () => {
      await button('Teach').props.onClick();
    });
    expect(api.teach).toHaveBeenCalledWith({
      dotId: 'dot-a',
      reviewId: review.id,
      settings: {},
    });
    expect(text()).toContain(review.descriptorUrl);
    expect(root.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
  });
  it('shows account setup and saves the client ID before browser connection', async () => {
    const api = bridge();
    api.list.mockResolvedValue({
      ok: true,
      value: { available: true, bindings: [binding], activity: {} },
    });
    await mount();
    expect(text()).toContain('Setup needed');
    expect(
      root.root
        .findAllByType('a')
        .some((a) => a.children.join('') === 'Setup guide'),
    ).toBe(true);
    const input = root.root.findByProps({ 'aria-label': 'Client ID' });
    await act(async () =>
      input.props.onChange({ target: { value: 'personal-client' } }),
    );
    await act(async () => button('Connect account').props.onClick());
    expect(api.connect).toHaveBeenCalledWith({
      dotId: 'dot-a',
      bindingId: binding.id,
      accountId: 'account',
      clientId: 'personal-client',
    });
  });
  it.each(['Disabled', 'Ready', 'Running', 'Blocked'])(
    'shows %s state without adding permission prompts',
    async (state) => {
      const api = bridge();
      api.account.mockResolvedValue({ ok: true, value: { connected: true } });
      api.list.mockResolvedValue({
        ok: true,
        value: {
          available: state !== 'Blocked',
          bindings: [{ ...binding, enabled: state !== 'Disabled' }],
          activity: { [binding.id]: state === 'Running' },
        },
      });
      await mount();
      expect(text()).toContain(state);
    },
  );
  it('requires a fresh per-Dot review and shows changed access on update', async () => {
    const api = bridge();
    await mount();
    await act(async () => {
      root.update(<AbilitiesSection dotId="dot-b" dotName="Scout" />);
    });
    expect(api.list).toHaveBeenLastCalledWith({ dotId: 'dot-b' });
    expect(api.teach).not.toHaveBeenCalled();
    await act(async () => {
      root.update(
        <PermissionReview
          dotName="Scout"
          review={{
            ...review,
            changes: [
              {
                key: 'permission:search',
                kind: 'changed',
                requiresConsent: true,
              },
            ],
          }}
          onTeach={async () => {}}
          onCancel={() => {}}
        />,
      );
    });
    expect(text()).toContain('Changed access');
    expect(text()).toContain('Scout');
  });
});
describe('private result cards', () => {
  it('fetches through trusted IPC and renders provider text without executable markup', async () => {
    const api = bridge(),
      handle = randomUUID();
    await act(async () => {
      root = create(<AbilityResultCard dotId="dot-a" handle={handle} />);
    });
    expect(api.results).toHaveBeenCalledWith({ dotId: 'dot-a', handle });
    expect(text()).toContain('SPOTIFY_SENTINEL');
    expect(root.root.findAllByType('script')).toHaveLength(0);
    const html = renderToStaticMarkup(
      <OwnerResultView
        result={{ kind: 'text', text: '<script>SPOTIFY_SENTINEL</script>' }}
      />,
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('asks for refreshing an expired result instead of retrieving it from history', async () => {
    const api = bridge();
    api.results.mockResolvedValue({ ok: true, value: null } as never);
    await act(async () => {
      root = create(<AbilityResultCard dotId="dot-a" handle={randomUUID()} />);
    });
    expect(text()).toContain('expired');
  });
  it('sends only a host-issued selection reference to the next turn', async () => {
    const api = bridge(),
      handle = randomUUID(),
      itemId = randomUUID(),
      onSelect = vi.fn();
    api.results.mockResolvedValue({
      ok: true,
      value: {
        kind: 'list',
        title: 'Private choices',
        items: [{ id: itemId, label: 'SPOTIFY_SENTINEL', selectable: true }],
      },
    } as never);
    await act(async () => {
      root = create(
        <AbilityResultCard dotId="dot-a" handle={handle} onSelect={onSelect} />,
      );
    });
    await act(async () => {
      await button('Choose').props.onClick();
    });
    expect(api.select).toHaveBeenCalledWith({ dotId: 'dot-a', handle, itemId });
    expect(onSelect).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9-]{36}$/),
    );
    expect(JSON.stringify(onSelect.mock.calls)).not.toContain(
      'SPOTIFY_SENTINEL',
    );
  });
});
