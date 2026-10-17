import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const directories: string[] = [];
const signingScript = path.resolve('scripts/sign-desktop.mjs');
function fixture(version: number): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'dots-signing-'));
  directories.push(directory);
  const app = path.join(directory, 'Dot Fixture.app');
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(path.join(app, 'Contents/Resources/app/native'), {
    recursive: true,
  });
  writeFileSync(
    path.join(app, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>com.myownstack.dots.signing-fixture</string>
    <key>CFBundleExecutable</key><string>DotFixture</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    </dict></plist>`,
  );
  for (const executable of [
    'Contents/MacOS/DotFixture',
    'Contents/Resources/app/native/desktop-observer',
  ]) {
    const compile = spawnSync(
      'clang',
      ['-x', 'c', '-', '-o', path.join(app, executable)],
      {
        input: `int main(void) { return ${version}; }`,
        encoding: 'utf8',
      },
    );
    expect(compile.status, compile.stderr).toBe(0);
  }
  return app;
}
function sign(app: string, identity: string) {
  return spawnSync(process.execPath, [signingScript, app], {
    env: { ...process.env, DOTS_CODESIGN_IDENTITY: identity },
    encoding: 'utf8',
  });
}
function requirement(target: string): string {
  const display = spawnSync('codesign', ['--display', '-r-', target], {
    encoding: 'utf8',
  });
  expect(display.status).toBe(0);
  return `${display.stdout}\n${display.stderr}`.match(
    /^(?:# )?designated => (.+)$/m,
  )![1];
}
afterAll(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'darwin')(
  'desktop package signing',
  () => {
    it('signs the bundled observer and app with explicit ad-hoc fallback', () => {
      const app = fixture(0);
      const result = sign(app, '');
      expect(result.status, result.stderr).toBe(0);
      expect(
        spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status,
      ).toBe(0);
      const observer = path.join(
        app,
        'Contents/Resources/app/native/desktop-observer',
      );
      expect(requirement(observer)).toContain('cdhash');
      const observerInfo = spawnSync(
        'codesign',
        ['--display', '--verbose=4', observer],
        { encoding: 'utf8' },
      );
      expect(observerInfo.stderr).not.toContain('linker-signed');
      expect(requirement(app)).toContain('cdhash');
    });
    it.skipIf(
      !process.env.DOTS_CODESIGN_IDENTITY ||
        process.env.DOTS_CODESIGN_IDENTITY === '-',
    )(
      'keeps both app and observer identity compatible across changed certificate-signed builds',
      () => {
        const first = fixture(0),
          second = fixture(1);
        const identity = process.env.DOTS_CODESIGN_IDENTITY!;
        expect(sign(first, identity).status).toBe(0);
        expect(sign(second, identity).status).toBe(0);
        for (const relative of [
          '',
          'Contents/Resources/app/native/desktop-observer',
        ]) {
          const a = path.join(first, relative),
            b = path.join(second, relative);
          const before = requirement(a),
            after = requirement(b);
          expect(before).not.toContain('cdhash');
          expect(after).not.toContain('cdhash');
          const forward = spawnSync(
            'codesign',
            ['--verify', '--strict', '-R', `=${before}`, b],
            { encoding: 'utf8' },
          );
          expect(forward.status).toBe(0);
          expect(
            spawnSync('codesign', [
              '--verify',
              '--strict',
              '-R',
              `=${after}`,
              a,
            ]).status,
          ).toBe(0);
        }
      },
      30000,
    );
    it('fails a requested unavailable identity instead of silently falling back to ad-hoc', () => {
      const result = sign(fixture(0), 'DOTS-UNAVAILABLE-SIGNING-IDENTITY');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Desktop signing failed');
    });
  },
);
