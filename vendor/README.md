# Installed execution candidate

`myown-llm-integrator-0.3.0-rc.2.tgz` is the reviewed, built npm package from the project-local Integrator worktree. Dot consumes it as an installed package through `package.json` and the SHA-512 integrity in `package-lock.json`; it does not import sibling source files.

This local candidate is retained because the npm publishing session returned HTTP 401. It is not a public npm release. The package passed its JavaScript/Python suites and packed-consumer checks before pinning. Codex execution requires the qualified CLI 0.163.0 and existing ChatGPT subscription authentication; there is no paid API fallback.

For an upgrade, review the upstream/revision and execution boundary, build and test a new versioned package, update this artifact and lock together, then run Dot's core, native and affected behavioral acceptance. Do not edit `node_modules` as the source of a fix. Public publishing can replace the file dependency after the same version/integrity pairing is verified.

## Change from rc.1

The additive `reasoningEffort` option accepts `low`, `medium`, `high` or `xhigh`, verifies the effective provider configuration, and sends effort on each execution turn. Omitting it preserves the existing setting. Dots uses `low` only for effect-free conversation composition; task settings and the owner’s global configuration are unchanged. No dependencies, Python implementation or Python lockfile changed. The earlier rc.1 archive and patch remain as historical artifacts.

## Exact source and rebuild

Upstream: [Handriantog/My-Own-LLM-Integrator](https://github.com/Handriantog/My-Own-LLM-Integrator), maintained within MyOwnStack. Base revision: [`f0f0c63833cddbb5b0bba9bf3eaeab411606c35b`](https://github.com/Handriantog/My-Own-LLM-Integrator/commit/f0f0c63833cddbb5b0bba9bf3eaeab411606c35b). This candidate includes the additive execution changes in [the source patch](myown-llm-integrator-0.3.0-rc.2.patch), including tests, qualification scripts and documentation. It does not claim that the unmodified upstream commit contains those changes.

- npm archive SHA-256: `8319a1511d2d1d9c30b5f335a06a5c6bc51a3223787ca40ba46d7a2e7b5d6556`
- Source patch SHA-256: `298d79d9620064acbbc49c7b70150a1076b2b2d6dab535e99f25164bfb80eaea`
- Installed integrity: the `myown-llm-integrator` entry in `package-lock.json`.

To reconstruct in a disposable checkout of that repository, check out the exact base and apply this patch. `DOTS_CHECKOUT` below is the path to this Dots checkout:

```sh
git checkout f0f0c63833cddbb5b0bba9bf3eaeab411606c35b
git apply --check "$DOTS_CHECKOUT/vendor/myown-llm-integrator-0.3.0-rc.2.patch"
git apply "$DOTS_CHECKOUT/vendor/myown-llm-integrator-0.3.0-rc.2.patch"
node scripts/build.mjs
npm pack --ignore-scripts
```

The reviewed build script copies `src/` to `dist/`; it has no compiler or JavaScript dependency installation. A clean reconstruction from the public base plus this patch was applied and built locally: all 32 shipped files matched the vendored npm archive byte-for-byte. This verifies file contents, not reproducibility of gzip/tar metadata across npm versions. The patch also carries the original JavaScript qualification tests; Python tests require the pinned `python/uv.lock` environment described upstream. Licenses and notices remain inside the npm package.

The snapshot is a temporary, auditable source handoff while publication is unavailable. An upstream source PR and registry release remain separate work. Do not derive an upgrade from an untracked sibling checkout or silently replace this archive under the same integrity.
