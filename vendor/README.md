# Installed execution candidate

`myown-llm-integrator-0.3.0-rc.1.tgz` is the reviewed, built npm package from the project-local Integrator worktree. Dot consumes it as an installed package through `package.json` and the SHA-512 integrity in `package-lock.json`; it does not import sibling source files.

This local candidate is retained because the npm publishing session returned HTTP 401. It is not a public npm release. The package passed its JavaScript/Python suites and packed-consumer checks before pinning. Codex execution requires the qualified CLI 0.163.0 and existing ChatGPT subscription authentication; there is no paid API fallback.

For an upgrade, review the upstream/revision and execution boundary, build and test a new versioned package, update this artifact and lock together, then run Dot's core, native and affected behavioral acceptance. Do not edit `node_modules` as the source of a fix. Public publishing can replace the file dependency after the same version/integrity pairing is verified.

## Exact source and rebuild

Upstream: [Handriantog/My-Own-LLM-Integrator](https://github.com/Handriantog/My-Own-LLM-Integrator), maintained within MyOwnStack. Base revision: [`f0f0c63833cddbb5b0bba9bf3eaeab411606c35b`](https://github.com/Handriantog/My-Own-LLM-Integrator/commit/f0f0c63833cddbb5b0bba9bf3eaeab411606c35b). This candidate includes the additive execution changes in [the source patch](myown-llm-integrator-0.3.0-rc.1.patch), including tests, qualification scripts and documentation. It does not claim that the unmodified upstream commit contains those changes.

- npm archive SHA-256: `cda9da67a747eadd98f07fe70cdc20388b6450ef6f8e58a7d93c41480af334dd`
- Source patch SHA-256: `932f247d9cd7e7485134aef98487af20a12d88ab21329ee6b72860e0c15b7e98`
- Installed integrity: the `myown-llm-integrator` entry in `package-lock.json`.

To reconstruct in a disposable checkout of that repository, check out the exact base and apply this patch. `DOTS_CHECKOUT` below is the path to this Dots checkout:

```sh
git checkout f0f0c63833cddbb5b0bba9bf3eaeab411606c35b
git apply --check "$DOTS_CHECKOUT/vendor/myown-llm-integrator-0.3.0-rc.1.patch"
git apply "$DOTS_CHECKOUT/vendor/myown-llm-integrator-0.3.0-rc.1.patch"
node scripts/build.mjs
npm pack --ignore-scripts
```

The reviewed build script copies `src/` to `dist/`; it has no compiler or JavaScript dependency installation. A clean reconstruction from the public base plus this patch was applied and built locally: all 32 shipped files matched the vendored npm archive byte-for-byte. This verifies file contents, not reproducibility of gzip/tar metadata across npm versions. The patch also carries the original JavaScript qualification tests; Python tests require the pinned `python/uv.lock` environment described upstream. Licenses and notices remain inside the npm package.

The snapshot is a temporary, auditable source handoff while publication is unavailable. An upstream source PR and registry release remain separate work. Do not derive an upgrade from an untracked sibling checkout or silently replace this archive under the same integrity.
