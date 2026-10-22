# Author an Ability

An Ability is a versioned package that a user teaches to a selected Dot. The host
reviews its access before downloading executable contents or running code. Code
runs only during an authorized invocation. Each Dot has separate grants, settings,
private state, and account bindings. Approved calls do not prompt again.

The version-one contract is implemented in `src/shared/abilities/`, with desktop
installation, per-Dot consent, supervised execution and account handling. Source
and fixture verification do not announce a published host or Spotify release.

## Package

Use a gzip-compressed tar archive with a root `ability.json` manifest, code,
licenses, and prebuilt dependencies. Only regular files/directories are accepted;
no symlinks, hard links, devices, traversal, duplicate paths, case collisions, or
executable installers. JavaScript entrypoints use `runtime: "javascript"`;
TypeScript must be compiled before packaging. Python uses a separately configured
local interpreter with isolated startup. Native executables must be built for
the declared platform. The currently exercised target is `darwin-arm64`.

JavaScript uses the app's bundled Electron Node runtime; no external Node install
is needed for an Ability. Python is optional: the owner chooses an installed
interpreter in Dot settings and reviews its actual executable and read-only
runtime directory. A python.org framework launcher resolves to its inspected
`Resources/Python.app/Contents/MacOS/Python` binary. Python modules and native
libraries must already be bundled; the host does not create a virtual environment,
install a wheel, or start a system service. Python versions are author prerequisites;
unsupported/missing interpreters fail closed. Native files must be arm64 Mach-O
executables, not shell scripts. No code runs during interpreter inspection.

Confinement is exercised on macOS 26 Apple Silicon. The desktop's older minimum
deployment target does not establish Ability support on older macOS versions,
Intel Macs, Linux or Windows. See [verification evidence](../desktop/abilities-verification.md).

Do not run npm/pip/postinstall on the user's machine. A worker cannot directly
spawn processes, open sockets, read another Dot's data, access credentials, or
modify package/runtime files. Its cwd/HOME are its private binding directory;
TMPDIR is a private subdirectory. For helpers, declare immutable package
entrypoints and request the `helper` capability during a valid invocation.

Workers receive three-second native leases renewed only after current authority
checks. A frozen desktop cannot indefinitely retain a worker: missed renewal
starts TERM and, after two seconds, KILL/reaping. The watchdog also enforces the
60-second execution ceiling independently of the desktop event loop. A stall can
therefore interrupt a valid invocation; do not retry a possibly completed mutation.

Start with the complete [fixture manifest](../../tests/fixtures/abilities/manifest.json)
and [generated JSON Schema](manifest.schema.json). Unknown fields are errors.
Source owner/repository and Ability ID are lowercase canonical identifiers.
Identity is `owner/repository:id`; the package additionally binds its version and
SHA-256. A repository with the same Ability name cannot replace yours.

Publish a descriptor JSON alongside the archive in a public GitHub release:

```json
{
  "formatVersion": 1,
  "manifest": "REPLACE WITH THE FULL ability.json OBJECT",
  "sourceCommit": "REPLACE WITH THE 40-CHARACTER LOWERCASE COMMIT HASH",
  "releaseTag": "spotify/v0.1.0",
  "asset": {
    "id": 123456,
    "name": "spotify-0.1.0-darwin-arm64.tar.gz",
    "sha256": "REPLACE WITH THE 64-CHARACTER LOWERCASE ARCHIVE HASH",
    "compressedBytes": 10000,
    "extractedBytes": 30000,
    "fileCount": 5
  }
}
```

The placeholders above are illustrative and deliberately fail validation. The
asset ID is GitHub's release asset ID, not a value invented by the author. Sizes,
file count, source commit, archive digest, and packaged manifest must match the
reviewed descriptor. Moving a tag or replacing an asset invalidates that review.
Private repositories are outside this first installer. Limits are 256 KiB for
the descriptor, 256 MiB compressed, 1 GiB extracted, and 20,000 archive entries.

## Permissions

Each permission has a unique `id`, `kind`, and plain-text `purpose`. The UI shows
the actual structured access as well as the explanation. Private binding state
is implicit. Only these explicit capability kinds are accepted:

- `https`: exact HTTPS `origin`, one `method`, `path` segments, `pathValues`
  schema, `query` schema, optional `body` schema, and optional OAuth `account` ID.
  A path segment is a literal or `{ "param": "itemId" }`. Parameters are required
  strings; decoded slashes, percent escapes, traversal, and URL syntax are denied.
  The worker supplies a rule ID and values, never a URL or authorization header.
- `oauth`: exact `authorizationUrl`, `tokenUrl`, `resourceOrigin`, nonsecret
  `clientIdSetting`, and explicit `scopes`. PKCE and credentials belong to the
  desktop. Authentication endpoint origins cannot also be worker HTTPS rules in
  version one. The host never exposes token responses or token endpoints.
- `helper`: the `helperId` of a declared helper. Each helper has `id`, `entrypoint`
  (`runtime`, `path`), and a constrained object `arguments` schema. Helpers share
  the parent's authority, deadline, and worker limit.

OAuth, HTTP, and helper references must resolve within this manifest. Account
resource origins must match the corresponding HTTP rule. Network resolution and
actual socket destinations are checked by the host; declaring a hostname does
not allow private-address access. No wildcard origins, arbitrary headers, proxies,
redirected credentials, Accessibility, printing, or system services are supported.

## Schemas and updates

Inputs, settings, request fields, helper arguments, and outputs use a limited
JSON Schema vocabulary. Allowed types are null, boolean, string, number, integer,
array, and object. Strings require `maxLength` (at most 16,384); arrays require
`items` and `maxItems` (at most 1,000). Optional minimum bounds and scalar `enum`
are supported. Objects require `properties`, `required`, and
`additionalProperties: false`, with at most 64 properties. Nesting is limited to
eight schema levels. Inputs/settings/helper arguments are objects. No `$ref`,
regex, recursion, executable expressions, coercion, or unknown keywords are accepted.

The exported JSON Schema supports editor validation; host semantic checks also
enforce unique IDs, cross-references, bounds, path bindings, and recursion limits.
It cannot replace `parseManifest`. Changing origins, scopes, helpers, runtime,
settings, publisher/source, or owner-only visibility requires review. Each update
still binds new code to the exact artifact digest, even if permissions are equal.

See [the worker protocol](protocol.md) for messages, limits, private result flow,
and error behavior. Treat manifest descriptions and results as plain text.
