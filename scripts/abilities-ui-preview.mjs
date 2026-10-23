import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import postcss from 'postcss';
import { darkTheme } from '../src/build/dark-theme.ts';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

// Production components and styles, synthetic bridge only; no workspace or accounts.
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'artifacts/desktop/abilities');
await mkdir(output, { recursive: true });
const descriptors = await Promise.all(
  ['mouse-mover-0.1.0', 'spotify-0.1.1', 'spotify-local-0.1.1'].map(
    async (name) =>
      JSON.parse(
        await readFile(
          path.join(
            root,
            'tests/fixtures/abilities/mouse-mover',
            name + '.json',
          ),
          'utf8',
        ),
      ),
  ),
);
const catalog = JSON.parse(
  await readFile(
    path.join(root, 'tests/fixtures/abilities/mouse-mover/catalog.json'),
    'utf8',
  ),
);
const documents = Object.fromEntries(
  descriptors.map((d) => [
    d.manifest.id,
    execFileSync(
      '/usr/bin/tar',
      [
        '-xOf',
        path.join(
          root,
          'tests/fixtures/abilities/mouse-mover',
          `${d.manifest.id}-${d.manifest.version}.dot-ability.tar.gz`,
        ),
        'README.md',
      ],
      { encoding: 'utf8' },
    ),
  ]),
);
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/client/style.css';
import './src/client/workspace.css';
import { AbilityManager } from './src/client/abilities/AbilityManager';
const descriptors=${JSON.stringify(descriptors)};
const catalog=${JSON.stringify(catalog)},documents=${JSON.stringify(documents)};
const ok=value=>Promise.resolve({ok:true,value});
const installations=descriptors.map(d=>({digest:d.asset.sha256,manifest:d.manifest,enabled:false,enabledDots:0,restored:false,settings:{},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
window.previewId='mouse-mover';
window.dotAbilities={
 catalog:()=>ok({available:true,installations:location.search?[]:installations,dots:[]}),
 browse:()=>ok({sourceCommit:descriptors[0].sourceCommit,entries:catalog.abilities.map(d=>({...d,publisher:'Handriantog',sourceUrl:'https://github.com/Handriantog/My-Own-Dot-Abilities/tree/'+descriptors[0].sourceCommit+'/'+d.path}))}),
 documentation:({digest,id})=>ok({markdown:documents[id ?? installations.find(a=>a.digest===digest).manifest.id]}),
 reviewInstallLocal:()=>{const d=descriptors.find(d=>d.manifest.id===window.previewId);return ok({id:'preview-'+d.manifest.id,descriptor:d,changes:[],expiresAt:Date.now()+60000,localSource:'/tmp/isolated-preview/'+d.manifest.id+'.dot-ability.tar.gz',storage:{packagePath:'/tmp/isolated-preview/abilities/packages/'+d.asset.sha256,stateParent:'/tmp/isolated-preview/abilities/private'}});},
};
createRoot(document.getElementById('app')).render(<AbilityManager/>);
`;
const compiled = await build({
  stdin: {
    contents: entry,
    resolveDir: root,
    sourcefile: 'abilities-preview.tsx',
    loader: 'tsx',
  },
  bundle: true,
  format: 'esm',
  write: false,
  outdir: output,
  platform: 'browser',
  jsx: 'automatic',
  plugins: [
    {
      name: 'production-theme',
      setup(build) {
        build.onLoad({ filter: /\.css$/ }, async ({ path: filename }) => ({
          contents: (
            await postcss([darkTheme()]).process(
              await readFile(filename, 'utf8'),
              { from: filename },
            )
          ).css,
          loader: 'css',
          resolveDir: path.dirname(filename),
        }));
      },
    },
  ],
  define: { 'process.env.NODE_ENV': '"production"' },
});
const js = compiled.outputFiles.find((f) => f.path.endsWith('.js')).contents;
const css = compiled.outputFiles.find((f) => f.path.endsWith('.css')).text;
const html =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/preview.css"></head><body><main id="app" style="height:100vh;width:100vw"></main><script type="module" src="/preview.js"></script></body></html>';
await writeFile(path.join(output, 'index.html'), html);
await writeFile(path.join(output, 'preview.js'), js);
await writeFile(path.join(output, 'preview.css'), css);
const server = createServer((req, res) => {
  res.setHeader(
    'Content-Type',
    req.url === '/preview.js'
      ? 'text/javascript'
      : req.url === '/preview.css'
        ? 'text/css'
        : 'text/html',
  );
  res.end(
    req.url === '/preview.js' ? js : req.url === '/preview.css' ? css : html,
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const evidence = [];
try {
  for (const width of [1120, 360])
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        deviceScaleFactor: 1,
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await page
        .getByRole('button', { name: 'Open Mouse Mover', exact: true })
        .waitFor();
      const capture = async (name) => {
        const measured = await page.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
          icons: [...document.querySelectorAll('.ability-icon svg')].filter(
            (e) => e.getBoundingClientRect().width > 0,
          ).length,
        }));
        if (measured.scroll > width || errors.length)
          throw Error(JSON.stringify({ name, measured, errors }));
        const filename = theme + '-' + width + '-' + name + '.png';
        await page.screenshot({
          path: path.join(output, filename),
          fullPage: true,
        });
        evidence.push({ filename, ...measured, errors: [...errors] });
      };
      await capture('list');
      for (const d of descriptors) {
        if (
          width === 360 &&
          (await page
            .getByRole('button', { name: 'Back to Abilities' })
            .count())
        )
          await page.getByRole('button', { name: 'Back to Abilities' }).click();
        await page
          .getByRole('button', { name: 'Open ' + d.manifest.name, exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Permissions', exact: true })
          .click();
        await capture(d.manifest.id + '-permissions');
        await page
          .getByRole('button', { name: 'Details', exact: true })
          .click();
        await capture(d.manifest.id + '-details');
        if (width === 360)
          await page.getByRole('button', { name: 'Back to Abilities' }).click();
        await page.evaluate((id) => (window.previewId = id), d.manifest.id);
        const add = page.getByRole('button', {
          name: 'Add Ability',
          exact: true,
        });
        if ((await add.getAttribute('aria-expanded')) !== 'true')
          await add.click();
        await page
          .getByRole('button', { name: 'Choose local Ability…', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Install', exact: true })
          .click();
        await page
          .getByRole('region', { name: 'Review Ability permissions' })
          .waitFor();
        await capture(d.manifest.id + '-review');
        await page
          .getByRole('button', { name: 'Install', exact: true })
          .scrollIntoViewIfNeeded();
        await capture(d.manifest.id + '-review-footer');
      }
      await page.goto(
        'http://127.0.0.1:' + server.address().port + '/?library',
      );
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await page
        .getByRole('button', { name: 'Open Mouse Mover', exact: true })
        .waitFor();
      await capture('catalog');
      await page.close();
    }
  await writeFile(
    path.join(output, 'evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log(JSON.stringify({ output, captures: evidence.length, evidence }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
