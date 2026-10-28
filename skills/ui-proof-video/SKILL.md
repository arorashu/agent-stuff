---
name: ui-proof-video
description: Record and verify continuous video evidence of UI changes through real app navigation, with visible actions, contextual captions, runtime provenance, and an auditable artifact manifest. Use for developer UI proof, not generated demos or marketing videos.
---

# UI proof video

Produce evidence a reviewer can follow from a known running app to the claimed
behavior. Use the environment's available browser/recording tools and read their
instructions before operating them. Keep project URLs, ports, titles, output
paths, delivery folders, and scenario details in task configuration, not here.

## Establish what the recording can prove

- Record the source checkout, branch, exact commit, working-tree diff/status,
  and build/start commands. Verify that the runtime serves that source: use an
  owned server on an assigned port with server reuse disabled, or a verifiable
  build identifier matching the checkout. A matching Git HEAD alone does not
  establish which build is running. Record relevant tool/runtime versions.
- Define the user journey, positive assertions, removed/changed behavior, and
  retained behavior before capture. Assertions must run along the recorded flow;
  successful screenshots alone are insufficient. Observe page/console errors and
  relevant requests, and report unexpected failures rather than hiding them.
- Prefer deterministic data in an isolated local app/API/database when practical.
  Inspect setup and teardown before running a repository's default test config:
  it may delete shared users or data. Use only owned accounts, stores, processes,
  and temporary resources; no destructive default teardown or shared-data resets.
  A remote production environment is not required.
- A real application and router with mocked API responses is **fixture-backed UI
  E2E**, not full-stack E2E. Label fixture data in the opening caption and manifest,
  specify which boundaries are mocked, and keep backend test evidence separate.
  UI absence proves visible absence in the exercised states, not absence of a
  backend job, database row, request outside the observation window, or deployment.
- Use a clean recording profile and synthetic or approved data. Keep credentials,
  private profiles, personal notifications, and unrelated windows out of capture.

## Capture the actual journey

- Capture desktop at **1280×800** and mobile at **375×667**, unless the task sets
  other dimensions. Run each viewport's actual responsive layout independently;
  do not resize a desktop screenshot into mobile evidence. Record device scale,
  touch emulation, capture size, and any final caption padding separately.
- Begin with initial navigation to a usable app. Thereafter navigate using visible
  controls, including return paths, and show loading, scrolling, and route changes
  continuously. Do not use direct URL jumps, state injection, or hidden cuts to
  connect demonstration scenes. Data seeding may happen before capture.
- Make the pointer visible in the recorded output. Move progressively along a
  human-paced path to the actual target, pause briefly, click, and leave time to
  read the result. Use smooth incremental scrolling with reading pauses. As a
  starting point, allow 1–2 seconds on meaningful states and 3–5 seconds per caption;
  adjust for content. Do not apply content-scroll visibility margins to fixed
  navigation controls: click their actual on-screen position without unnecessary
  scrolling. Do not accelerate footage to conceal actions or waits.
- If headless capture omits the cursor, a recording-only overlay may track actual
  mouse events and clicks, including after navigation. The overlay must not
  intercept input or alter application behavior. Record its mechanism. Never
  hide components, replace content, or modify app DOM/CSS to simulate the change.
- Put concise context at the top and action/result captions at the bottom, preferably
  in separate video gutters. Preserve the app viewport and aspect ratio; do not
  cover navigation, controls, evidence, or errors. Keep a timed SRT/VTT or equivalent
  caption source. For H.264 with odd viewport dimensions, pad to even export
  dimensions rather than scaling the app; record the padding. Distinguish expected
  behavior from observations and limitations.
- Keep the original continuous capture and a timestamped action/assertion log
  keyed to its timeline, including pointer actions, scrolls, routes, waits, and
  errors. Save the scenario/recorder command and configuration. Preserve failed
  takes as failures; do not join different takes into an apparently continuous run.

## Verify the delivered video

Export MP4 using H.264, `yuv420p`, and fast start. Preserve the raw recording;
captioning/transcoding must keep scene order and timing, with no hidden jump cuts,
synthetic UI, or generated transitions. Audio is optional; unrelated music adds
no proof. A typical conversion, when no caption compositing is needed, is:

```sh
ffmpeg -i raw.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an proof.mp4
ffprobe -v error -show_format -show_streams -of json proof.mp4
ffmpeg -v error -i proof.mp4 -f null -
sha256sum proof.mp4
```

Check the final export, not just the raw take or browser screenshots:

- Inspect every scene and frames immediately before, during, and after each route
  transition, click result, and significant scroll. Use timestamped extracted
  frames/contact sheets, and play the video when a playback tool is available.
  Still frames alone cannot establish pacing or uninterrupted transitions; disclose
  if playback/continuity review remains incomplete.
- Confirm visible pointer motion/click context, readable uncropped captions,
  retained layout at each viewport, actual asserted content, and no stale build,
  blank/error frames, obscured controls, or unexplained jumps. Review narrow mobile
  captions at their delivered resolution. Re-record a failed journey instead of
  masking its failure in editing.
- Record ffprobe codec, pixel format, dimensions, duration, and size; check fast
  start using MP4 atom order or an appropriate media inspector. Record SHA-256 of
  each delivered file and decode the full stream to check integrity. Encoding or
  decoding success alone does not establish visual correctness.

## Manifest and delivery

Keep a machine-readable manifest beside the artifacts. Include:

- run ID/time, project/source path, exact head, dirty diff reference/hash if any,
  runtime/build provenance, start/record/export commands and tool versions;
- data mode and isolation, mocked boundaries, tested journeys/assertions with
  results and logs, separate backend evidence, errors/skips, and known limitations;
- each viewport and capture/export dimensions, duration, codec/pixel format,
  byte size/SHA-256, raw capture, captions, action log, screenshots, inspection
  frames/timestamps, and completed or outstanding review;
- approval scope where required, and delivery receipt/readback evidence after upload.

For Google Drive delivery, use the existing **google-drive** skill and currently
available authenticated connector tools. Do not implement credential transport or
read tokens/cookies. Inspect the tool's actual upload input contract; do not infer
local-path support or limits from a cached example. Ground the exact authorized
folder by metadata before writing. Upload only the approved artifact(s) to that
folder; preserve sharing, avoid empty probe files, and never fall back to root or
another destination. Do not broaden a video approval into uploading raw traces or
other files containing additional data.

After upload, read back the observed file ID and verify name, parent folder ID,
MIME type, and size/checksum where the connector exposes them. Compare checksums
using the same algorithm; Drive MD5 and local SHA-256 are not interchangeable.
Record unavailable fields as limitations. Return only a URL observed in a
completed connector response/readback. If a write has an uncertain outcome,
reconcile the exact destination before retrying to avoid duplicate uploads.
If the connector is unavailable, report the missing capability and required
connection action; do not invent a delivery URL or change permissions.
