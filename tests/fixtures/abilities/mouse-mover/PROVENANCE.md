# Sealed collection fixture

Source: https://github.com/Handriantog/My-Own-Dot-Abilities

Original 0.1.0 Mouse Mover and unchanged Spotify fixture source commit: `d2b874679978456e61ce2304a89d277533e0bbad`.
Development archives rebuilt with each Ability’s `scripts/package.py --development`.
No native effects or accounts are exercised by these fixtures.
Descriptor and catalog bytes are preserved exactly (excluded from formatting).

- `catalog.json`: `0b6e1301f599aff6499a3a9cdbaae59878cf8a836be8e9fbbcddc8fe97f57e21`
- `mouse-mover-0.1.0.dot-ability.tar.gz`: `2a327465703d08a24a58026ef8b61bb58c87e38bf8cc8bd920b03a8ed84d19b5`
- `mouse-mover-0.1.0.json`: `831a3ca96ced459190dd2e92cfdba0ea482a97439c394c35220d0ad76d612d62`
- `spotify-0.1.1.dot-ability.tar.gz`: `f262296d7f726767c4e361df495adb8523490bd7647d1a84b0f699f57ae7c675`
- `spotify-0.1.1.json`: `1f6b0986355964ee92fb6e90951be147a33515249739d2ff3455b1ef10153763`
- `spotify-local-0.1.1.dot-ability.tar.gz`: `6149c34a6ef1f93f725a0524d540825f57e996757eb8bd3fa80de2da60c2903c`
- `spotify-local-0.1.1.json`: `612113b31d225cfc2985f79b4342ce273cf82a9133b8998def2ef79494a1f2f2`

## Floor walk fixture

Mouse Mover 0.1.1 comes from clean collection commit
`4d70173e8c3999ab392827bc923409cbb4212a56`. Its inventory records `dirty: false`.
Generated with `python3 abilities/mouse-mover/scripts/package.py --development
--output dist/floor-walk-source`. The shared schema is pinned to host commit
`da68cc2101e8d44d0b329037a9f50bc183ebc466`.
The 0.1.0 fixture remains solely for authored-path compatibility tests; Spotify
0.1.1 archives and the unpublished catalog remain byte-for-byte unchanged.

- `mouse-mover-0.1.1.dot-ability.tar.gz`: `5b8edeb70de232ae355d703d61046123582535e6369f7c1cc057f26362a6a934`
- `mouse-mover-0.1.1.json`: `8cd9171bfcf7c96cafea79fe18564b40275ed7d3dfba85923ee055bf567c4d5a`
