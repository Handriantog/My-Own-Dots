# Desktop companion final review and resolutions

An independent reviewer examined `9d210fd..3b8f16b` against the approved design, implementation plan, and five explicit review focus areas. It found no Critical issues, four Important issues, and no Minor issues. The original verdict required fixing those four issues before integration. The implementer reproduced and fixed them in one pass; the fixes were verified with regressions rather than a second review.

| Finding                                                 | Resolution and evidence                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Occluded pull-up destination remained cached            | Revalidate the exact landing footprint on every world update. Preserve the trajectory while valid; otherwise detach from the current position. Refresh walking climb targets when their wall moves. Two simulation regressions failed before the fix and pass afterward.                                                                                  |
| Queued old geometry became fresh after a host stall     | Map helper uptime onto the host monotonic clock using the minimum session transport offset. Delayed increasing sequences cannot refresh expired supports. Delayed-queue and changing-offset regressions failed before the fix and pass afterward.                                                                                                         |
| Vertically stacked display restoration used X only      | Resolve placement with both axes and half-open display bounds. Tests cover both monitor enumeration orders, overlapping X ranges, and the shared vertical boundary. The regression failed before the fix and passes afterward.                                                                                                                            |
| Invalid-scene gate remained hidden after helper failure | Visibility reads current observation validity instead of a latched flag. Missing/expired tracking returns to floor-only mode independently from screen-lock hiding. Host callback tests cover invalidation then helper failure/retry exhaustion, expiration without exit, and lock/unlock. The two faulty paths failed before the fix and pass afterward. |

Additional QA found a rendered palm/contact gap during pull-up and a held grip surviving stale tracking. The palm uses its authored two-axis pivot and slides inward along the exposed top as the body crosses the corner. A geometric rig regression reduced a measured 16.68-pixel contact error to below two logical pixels. Expired tracking cancels capture; a host regression demonstrates release. Both regressions were observed failing before the changes and passing afterward.

Final combined verification: **516 passed, 19 existing skips**; typecheck and lint pass. No reported Important/Critical finding remains unfixed. Real desktop acceptance remains explicitly separate in [verification.md](verification.md).

## Decisions on areas the reviewer declined to judge

1. **Sound refinement remains deferred**, as the owner requested; event synchronization and cancellation are implemented. Cost if wrong: some effects remain too rough until the next sound pass.
2. **Chat, voice, agent tasks, multiple creatures, and Windows/Linux remain outside this delivery**, matching the approved scope. Cost if wrong: this app is a companion shell and needs another integration phase to act as the full assistant.
3. **Deliver a local ad-hoc signed arm64 build without public notarization**, because no release identity is available. Cost if wrong: other Macs can refuse to launch the archive until a proper signed release is produced.
4. **Do not claim native input/focus/cursor/Spaces/mixed-DPI/sleep acceptance from unit tests or Electron flags.** Desktop-control binding failed and Accessibility remains disabled. Cost if wrong: platform-specific interaction defects can remain despite passing automated tests.
5. **Keep failed instrumented probes visible in the record and make no causal claim from their disconnects.** Completed and incomplete live runs are distinguished in verification. Cost if wrong: a longer-lived native or harness issue may still need diagnosis.
6. **Accept the author's inspected plush contact sheet as visual evidence, while leaving physical audio latency unmeasured.** The reviewer did not independently perform an art/listening session. Cost if wrong: motion/art tuning or output-device synchronization work remains.
7. **Use exposed rectangular window edges and the display work-area floor; exclude exact Dock contours and protected system surfaces**, as specified. Cost if wrong: Dot will not stand on individual Dock icons, and macOS security UI may cover it.

No deferred Minor findings were reported. No merge, push, publication, or permission grant was performed as part of this local delivery.

## October 17 owner-feedback refinement review

A separate read-only review of the refinement diff found three P2 issues. All were reproduced with failing regressions, then fixed:

1. A climb stroke used host elapsed time, so resuming after a ten-second interruption jumped the body by 28 pixels. Stroke progress now accumulates fixed simulation steps; stall and suspend/resume tests preserve both body and palm continuity.
2. Unconditional overlay containment clipped a held body when the pointer crossed a monitor seam ahead of the actual grabbed body. Held and partially offscreen recovery states retain a root-centered surface; autonomous contained states keep their panel within the active display.
3. Pausing during the initial reach changed to a fully attached hang pose immediately. The reach now finishes smoothly before entering hang, including reduced-motion changes.

The follow-up reviewer independently checked all three fixes, both climb directions, and found no remaining important issue. Observed palm movement through the interrupted reach remained below 4.7 pixels/frame.

Rulings on deferred judgments: physical external-monitor flicker remains an explicit owner acceptance check because only one display is connected here; visual/reference judgment was handled separately through the actual-rig motion preview; documentation and preview changes were reviewed and verified in the main work stream. None of these is represented as native external-display proof.

A further pause/resume regression was reproduced in the main pass: a brief mid-wall pause could enter a pull-up to a distant top. Resuming now finishes the same interrupted climbing stroke; a pull-up requires both palm and body to have reached the ledge.
