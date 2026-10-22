# Ability host implementation decisions

Decisions made during the approved inline implementation, in ledger order. Each
records its rationale and cost if wrong. This is an implementation record, not a
claim of live provider verification or release readiness.

## Rulings I made

1. run standalone Apple SDK/Python/Node acceptance before npm setup — first feasibility gate requires no new third-party package, and can reject the platform approach before dependency installation — cost if wrong: later application tests may reveal additional runtime allowances; no third-party execution is enabled yet.

2. reuse the matching existing dependency installation through a worktree-local symlink — every applicable package version and lockfile matches, and the Integrator Python environment exists; this avoids executing install hooks or changing shared dependencies — cost if wrong: clean CI may expose setup differences, so it remains required before PR readiness.

3. add package lookup/removal, binding lookup by digest, enable, and receipt reads to the explicit repository allowlist — later service operations need these narrow reads/transitions without direct database access — cost if wrong: extra internal API surface, still unavailable to workers and public request bodies.

4. preserve schema-3 and historical legacy restore inventories alongside the schema-4 migration now — postponing compatibility to Task 12 would break existing backups during intermediate verification — cost if wrong: restore inventory variants could be too permissive; exact-schema comparisons and migration/restore tests remain required.

5. move GitHub review transport and the reused public-address classifier into shared modules, retaining the desktop and browser exports — the production backend compiler excludes desktop-only files, and a real bundled-backend regression exposed the missing import — cost if wrong: a wider shared Node-only module surface; no browser bundle imports it and existing network tests remain required.

6. accept anonymous AF_UNIX stream socketpairs alongside directional POSIX pipes for trusted control/status descriptors — actual Node/libuv child stdio uses O_RDWR socketpairs; reject TCP and named Unix endpoints, and still close every extra worker descriptor — cost if wrong: broader trusted channel validation; real descriptor inspection, negative socket tests, and parent-death acceptance cover it.

7. allow owner/root-owned group-writable selected runtime files and read roots inside confinement, while keeping the unsandboxed watchdog non-group/world-writable — the installed python.org framework is root/admin 0775 and was rejected before execution; workers still cannot modify runtime resources — cost if wrong: external administrators can change selected runtime code; the threat boundary does not promise protection from a compromised unsandboxed host.

8. add 16 simultaneous capability requests and 2048 protocol frames per worker invocation as defensive bounds — frame byte limits alone allow unbounded pending handlers and identifier sets — cost if wrong: unusually chatty authors must batch work or split invocations; document the ceilings.

9. establish successful safe-target writes before the symlink replacement race, then require all 5000 racing attempts to leave the outside sentinel unchanged — one loaded run legitimately denied every racing Node open, while an isolated reproduction passed; the previous positive-success assertion depended on scheduling — cost if wrong: fewer guaranteed safe-target writes during churn, compensated by a deterministic positive control without weakening the outside-write assertion.

10. request identity encoding and reject compressed responses before decompression — this enforces the response ceiling without an inflater attack surface — cost if wrong: providers that insist on compression need a later bounded decoder; the v1 contract documents this restriction.

11. expose one host-internal HTTPS transport for the forthcoming OAuth exchanges, with the same DNS/TLS/deadline/redirect checks — prevents token transport from quietly weakening the resource broker boundary — cost if wrong: a wider internal API; no shared worker or renderer type can invoke it.

12. key account consent by approvedAt plus package digest/client ID and full binding identity, while validating the changing grant revision on every use — disable/re-enable should retain an unchanged approved account but invalidate old invocations — cost if wrong: consent identity must be advanced on a fresh review; store and OAuth tests cover this boundary.

13. add host-private current-account lookup, binding-wide deletion, optional account ID/cancellation, presence and stop methods; reuse the extracted protected-storage availability helper — host composition needs opaque account handles and reliable disconnect/quit cleanup without exporting tokens — cost if wrong: a slightly larger host-internal API, still absent from shared IPC.

14. accept omitted token scopes as unchanged requested/previous scopes, reject any explicit differing set — RFC 6749 permits omission only for unchanged scopes — cost if wrong: providers returning reduced scope require a new connection rather than partial capability use.

15. bound owner results to 128 entries and 16 MiB total, counting payload and display copies, with oldest eviction and active ten-minute expiry timers — per-frame limits alone do not bound session memory — cost if wrong: heavy browsing expires an older card early; no provider content is persisted.

16. add opaque item IDs and selectable flags to owner views while removing private action data; add host-only context/take operations and desktop list/account reads — trusted UI needs discovery and target choices, while selections must resolve only inside the host — cost if wrong: a larger strict IPC contract; unknown authority fields and action-bearing UI replies are rejected.

17. allow an explicitly selected item across tools of the same binding/thread/session/consent, with single-use opaque selection references — Spotify search must support a subsequent play/save action without passing provider identifiers to inference — cost if wrong: authors must validate whether selected action data is appropriate for the requested tool; all HTTP grants still apply.

18. add OAuth cancelBinding without deleting idle credentials — disabling must close pending sign-in immediately while preserving an unchanged connected account — cost if wrong: an interrupted token rotation may require reconnect, rather than leaving an uncertain refresh credential usable.

19. add authenticated binding lookup and advertise the backend's Ability storage root in desktop identity — an attached backend may use a different workspace from the desktop launcher's local configuration; derive packages and state beside that backend's database rather than guessing — cost if wrong: backend identity is a trusted filesystem-location boundary; only the authenticated literal-loopback connection supplies it.

20. use a strict tool argument envelope with arguments and optional selectionRef, and derive durable invocation UUIDs from binding/thread/tool-call identity — avoids collisions with author input fields and prevents duplicate delivery from repeating an action — cost if wrong: an upstream provider reusing call IDs for distinct commands receives a refusal instead of a repeated action.

21. add optional before/after maintenance hooks to the existing storage controller — automatic and manual operations must stop workers before snapshots or workspace mutation and reattach only after completion — cost if wrong: extra session churn during read-only maintenance previews; grants and idle encrypted accounts persist.

22. accept and validate settings with Teach/Update before install, and save client ID inside the trusted Connect action — required settings otherwise make installation impossible, and a second awaited renderer IPC can lose user activation — cost if wrong: consent/update API expands; strict schemas and service regressions cover it.

23. add host-generated package path/private state parent and activity to trusted IPC — consent must show actual file access and Running must reflect real workers — cost if wrong: stale status, so poll and fail closed; private state remains limited to the binding subfolder.

24. wire tool cards in Chat's existing wildcard renderer, leaving ChatTranscript's generic render hook unchanged — this is where computer and other tool cards are actually selected — cost if wrong: display coverage must include hidden tool-only messages.

25. Python is selected through a native file dialog and a second native read-access review, persisted privately per desktop profile, with framework/version roots inspected without execution — no renderer path or automatic interpreter discovery is trusted — cost if wrong: uncommon Python layouts may require rejection until supported; invalid/moved selection blocks only Python.

26. scope delegated Ability calls to the validated parent conversation and add a desktop-only latest-eight-handle inbox — voice child threads otherwise cannot display or consume private choices in their visible conversation — cost if wrong: cross-thread access; DotAgent validates parent ownership before mapping, host still checks Dot/session/grant/binding/thread and IPC returns handles only.

27. snapshot host context carries a source staging directory and validated state-key remapping — restoring creates a new workspace identity, while existing state keys hash workspace plus binding; remap using restored binding IDs without weakening host scoping — cost if wrong: private state could land in an inaccessible/wrong binding directory; verify exact restored paths and binding IDs.

28. add authenticated quiesce/resume commands and retain the desktop bridge during native storage maintenance — disconnecting the bridge prevents a server capture from obtaining a verified worker-stop acknowledgement — cost if wrong: backup may race worker writes; real confined state-writer test must prove stop before acknowledgement and no admission until resume.

29. archives containing Ability state use version/minimumReader 3 with an explicit state format, while unchanged inventories retain legacy v1/v2 — older readers must reject rather than drop new files — cost if wrong: compatibility and restore inventory mismatch; decoded archive and historical-version tests cover it.

30. a backend with Ability package records requires an attached host to acknowledge quiescence before backup — an absent heartbeat alone cannot prove a frozen desktop stopped a native worker — cost if wrong: headless backups with installed Abilities are blocked until the desktop reconnects; no silent incoherent capture.

31. add the cleanup table/known delete trigger to unreleased Ability storage schema 4 and run cleanup at desktop attachment and tool admission — the current product has no Dot-delete UI, but any actual row deletion must atomically revoke bindings and queue cleanup — cost if wrong: future deletion paths could leave secrets; trigger and acknowledgement-failure regressions enforce the boundary. Historical released schema 2/3 inventories remain accepted without Ability tables.

32. poll invocation authority every 500ms while workers are alive, with at most one outstanding check — a removed/revoked binding outside the normal command path otherwise leaves a native state-writing loop alive until the invocation deadline — cost if wrong: extra local IPC and fail-closed cancellation during backend failure; real state-writer revocation test failed before this change.

33. extract that unchanged filesystem primitive to shared/abilities/directory.ts and re-export from the installer — both runtimes need it without dragging desktop-only modules into the backend — cost if wrong: packaging drift; actual compiled-runtime and owned-backup tests are the regression gate. Historical-schema fixture teardown also removes the new unreleased cleanup table/trigger; incomplete mixed inventories remain rejected.

34. extend the existing offline legacy-migration path as well as move/restore — otherwise an installed Ability prevents conversion to SQLite or silently loses private state — cost if wrong: migration scope expands; a real PostgreSQL migration fixture verifies version-3 state and revoked consent. The offline capture's trusted quiescence callback is used only after stopWorkspace and an exclusive source database ownership claim.

35. compile one ability-runtime.cjs and externalize the desktop controller import to it — the artifact harness must exercise the same code shipped by the desktop without source paths — cost if wrong: missing adjacent bundle breaks startup; relocated production-app smoke checks the actual main import and all three runtimes.

36. inject only release metadata/download bytes in the sealed-artifact acceptance harness — publishing fixture releases is outside scope and network availability cannot prove confinement — cost if wrong: live GitHub release delivery remains separately unverified; archive hashes, extraction, host authority and OS execution remain production.

37. resolve a selected python.org bin launcher to its inspected same-framework Python.app interpreter — sealed Python smoke reproduced invalid_response because re-exec is denied — cost if wrong: alternate framework layouts fail closed; native read-access confirmation displays the actual resolved executable.

38. give worker-readiness polls five seconds while leaving revocation deadlines bounded — concurrent cold launches exceeded Vitest's default startup polling window, while the two isolated lifecycle suites passed 18/18 — cost if wrong: startup regressions take longer to fail; actual worker output and identity remain required.

39. add a three-second native lease renewed only after fresh authority and an independent sixty-second execution ceiling — SIGSTOP regression proved owner death/EOF alone leaves a frozen desktop's worker alive after backend expiry — cost if wrong: overloaded or stalled desktops interrupt otherwise valid work; mutation uncertainty and no automatic retries remain required.

40. retain the unchanged archive external-memory assertion after its isolated and complete reruns passed — a single full-suite measurement failure did not demonstrate a new archive streaming defect, and the assertion predates Abilities — cost if wrong: CI may expose the same measurement instability; report it rather than weakening the bound.

41. build the desktop-only Ability distribution in scripts/abilities/build.mjs rather than placing it in the backend runtime compiler — the backend deliberately excludes desktop host modules and the desktop build already composes separate workers — cost if wrong: desktop build wiring could drift; signing and relocated-app tests require all assets and the actual controller import.

42. defer the host PR/final whole-change review until the Spotify implementation and integration are also reviewable — one fresh strongest review can assess the real cross-repository boundary; the Spotify plan explicitly permits development against the frozen contract before the final host gate — cost if wrong: review changes can require updating the contract pin and rerunning integration. No installable/live/release claim or merge is made before those gates.

43. extend the unreleased API-1 manifest with optional tool channels and plain-text notices — actual provider restrictions require trusted voice exclusion and explicit pre-install agreement, not worker instructions or a README alone — cost if wrong: older development hosts reject these manifests and need the updated contract; existing manifests preserve both channels by default.

44. bind notice agreement to each reviewed package digest and require fresh acceptance for updates — the exact terms must be reviewable before install and changes cannot inherit silent agreement — cost if wrong: unchanged provider terms require another checkbox during an update.

45. inject provider DNS/TLS transport only through the in-process host constructor for packaged Spotify acceptance — exercises the real broker/PKCE/credentials path without live accounts or a localhost production exemption — cost if wrong: fixture TLS behavior can miss a real provider incompatibility; live account acceptance remains a separate gate.

46. retain the documented unsandboxed-host threat boundary — an already compromised owner process can change the app/runtime; malicious Ability code still faces real OS confinement — cost if wrong: users could assume protection against a compromised host, so authoring/evidence explicitly state this limit.

47. keep unavailable visual/keyboard, live provider compatibility and provider branding as explicit draft/publication gates — access is unavailable and fixture evidence cannot establish those results — cost if wrong: actual UI or provider behavior can still require fixes before release; no merge/publication or live-ready claim is made.

48. give the encrypted multi-stage portability test the existing archive-suite30s budget — it performs four real scrypt/encryption/decryption operations plus SQLite capture/restore on a shared Linux runner, where default5s expired; no runtime deadline or data/privacy assertion changes — cost if wrong: a real performance regression could take longer to fail; exact-head CI must pass and functional assertions remain intact.

## Deferred minors

None identified by the independent whole-change review.
