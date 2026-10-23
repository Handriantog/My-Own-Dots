import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const execute = promisify(execFile);
describe.skipIf(process.platform !== 'darwin')(
  'Spotify event encoding (no app interaction)',
  () => {
    let root: string, helper: string, labels: string;
    beforeAll(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'spotify-native-')));
      helper = join(root, 'control');
      await execute('/usr/bin/xcrun', [
        'clang',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-fobjc-arc',
        '-fblocks',
        '-O2',
        '-mmacosx-version-min=14.0',
        '-framework',
        'Foundation',
        '-framework',
        'AppKit',
        '-framework',
        'Carbon',
        resolve('native/spotify-control/main.m'),
        '-o',
        helper,
      ]);
      // Feed recorded AX attribute shapes to the real native identity function,
      // without looking up an app or requiring Accessibility in CI.
      labels = join(root, 'labels');
      const fixture = join(root, 'labels.m');
      await writeFile(
        fixture,
        `#import <ApplicationServices/ApplicationServices.h>
#import <AppKit/AppKit.h>
static AXError fixtureAX(AXUIElementRef e,CFStringRef a,CFTypeRef *v){id item=((__bridge NSDictionary *)e)[(__bridge NSString *)a];*v=item?CFBridgingRetain(item):NULL;return item?kAXErrorSuccess:kAXErrorNoValue;}
#define AXUIElementCopyAttributeValue fixtureAX
#define main unused_helper_main
#include ${JSON.stringify(resolve('native/spotify-control/main.m'))}
#undef main
int main(void){@autoreleasepool{char bytes[4096];size_t count=fread(bytes,1,sizeof(bytes),stdin);id input=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:bytes length:count] options:0 error:NULL];emit(identity((__bridge AXUIElementRef)input));return 0;}}
`,
      );
      await execute('/usr/bin/xcrun', [
        'clang',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-fobjc-arc',
        '-fblocks',
        '-O2',
        '-mmacosx-version-min=14.0',
        '-framework',
        'Foundation',
        '-framework',
        'AppKit',
        '-framework',
        'Carbon',
        fixture,
        '-o',
        labels,
      ]);
    });
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });
    const validate = (input: unknown, mode = '--validate') =>
      new Promise<unknown>((resolve, reject) => {
        const child = execFile(helper, [mode], { timeout: 3000 }, (e, out) =>
          e ? reject(e) : resolve(JSON.parse(out)),
        );
        child.stdin!.end(JSON.stringify(input));
      });
    it.each([
      { op: 'snapshot' },
      { op: 'press', id: 42 },
      { op: 'menu', id: 3 },
      { op: 'set', id: 8, value: 'a normal query' },
      { op: 'enter', id: 8 },
    ])(
      'validates private UI frame without contacting any app: %j',
      async (input) => {
        expect(await validate(input, '--validate-ui')).toEqual({ valid: true });
      },
    );
    it.each([
      { op: 'snapshot', app: 'com.apple.Terminal' },
      { op: 'press', id: -1 },
      { op: 'press', id: true },
      { op: 'key', key: 'super+q' },
      { op: 'set', id: 2, value: 'x', script: 'x' },
      { op: 'enter', id: 2, key: 'Return' },
    ])('rejects unsupported UI frame: %j', async (input) => {
      expect(await validate(input, '--validate-ui')).toEqual({
        ok: false,
        code: 'permission_denied',
      });
    });
    it('reads Spotify toast text from AXValue when its title and description are absent', async () => {
      const result = await new Promise<string>((resolve, reject) => {
        const child = execFile(labels, [], (error, out) =>
          error ? reject(error) : resolve(out),
        );
        child.stdin!.end(
          JSON.stringify({
            AXRole: 'AXStaticText',
            AXValue: 'Added to Liked Songs.',
          }),
        );
      });
      expect(JSON.parse(result)).toMatchObject({
        role: 'AXStaticText',
        label: 'Added to Liked Songs.',
      });
    });
    const code = (s: string) => Buffer.from(s).readUInt32BE();
    it.each([
      ['play', 'Play'],
      ['pause', 'Paus'],
      ['next', 'Next'],
      ['previous', 'Prev'],
    ])('encodes full four-byte %s event', async (action, event) => {
      expect(await validate({ action })).toEqual({
        valid: true,
        eventClass: code('spfy'),
        eventId: code(event),
      });
    });
    it.each([
      { action: 'volume', percent: 42 },
      { action: 'seek', seconds: 1.5 },
      { action: 'repeat', enabled: true },
      { action: 'shuffle', enabled: false },
    ])('encodes property setter $action', async (input) => {
      expect(await validate(input)).toEqual({
        valid: true,
        eventClass: code('core'),
        eventId: code('setd'),
      });
    });
    it.each([
      { action: 'play', script: 'x' },
      { action: 'volume', percent: 101 },
      { action: 'volume', percent: true },
      { action: 'seek', seconds: -1 },
      { action: 'repeat', enabled: 1 },
      { action: 'play_uri', uri: 'file:///etc/passwd' },
    ])('rejects malformed command %j before app lookup', async (input) => {
      expect(await validate(input)).toEqual({
        ok: false,
        code: 'permission_denied',
      });
    });
  },
);
