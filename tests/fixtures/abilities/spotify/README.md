# Sealed Spotify acceptance fixture

This is an offline development artifact from the MIT-licensed
[Ability repository](https://github.com/Handriantog/My-Own-Dot-Abilities), commit
`dcf2de644e1b78d24d4768f0a18619dcbfad37cf`. It is test input, not bundled app
functionality or a published Spotify release. Its archive contains original source,
MIT license, provider notices and a per-file inventory.

Archive SHA256: `45d5d09308a0276d2fc110f9daa976fa2bd22303c44b153dbe3486c536e38428`.
The descriptor's development tag and placeholder asset ID are for offline tests.
The test injects synthetic GitHub metadata/download bytes and a synthetic HTTPS
transport. Production installation, grant validation, PKCE/callback, encrypted
storage, exact HTTP rules, confinement, supervision and private results run normally.
No Spotify account or external provider request is used.

Rebuild using that repository's `abilities/spotify/scripts/package.py
--development --output <new-directory>` after committing package changes. Copy
both files and update this source/digest record together. The actual production
host parses and verifies their exact bytes in `abilities-spotify.test.ts`.
