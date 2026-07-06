# Permission Broker and Installer Plan

## Purpose

The Permission Broker makes OS capabilities explicit, inspectable, and
recoverable. Agents should never discover a permission problem by receiving a
blank recording.

## Responsibilities

- Check permission state.
- Request permission onboarding through native UI.
- Verify permissions with real probes.
- Install or update the recorder helper.
- Report capability state to `sporesd`.
- Explain degraded capture modes.
- Store local permission diagnostics.

## Non-Goals

- No recording session management.
- No privileged locked-screen unlock flow in v0.
- No silent system-setting mutation.
- No bypassing OS consent.

## Capability Model

```json
{
  "platform": "macos",
  "screen_recording": "granted",
  "accessibility": "missing",
  "input_monitoring": "not_requested",
  "microphone": "not_requested",
  "system_audio": "unsupported",
  "window_capture": "granted",
  "cursor_capture": "granted",
  "keyboard_metadata": "degraded",
  "requires_user_action": true
}
```

States:

- `granted`
- `missing`
- `pending`
- `denied`
- `not_requested`
- `unsupported`
- `degraded`

## macOS Permission Set

Required for v0:

- Screen Recording: capture pixels from displays/windows.
- Accessibility: inspect UI state and associate input with UI elements.

Optional later:

- Input Monitoring: richer keyboard event metadata.
- Microphone: voice narration.
- System Audio: app/system audio capture, platform-dependent.
- Automation/Apple Events: only for app-control features, not recording.

## Onboarding Flow

1. User or agent calls `spores doctor`.
2. Broker checks helper installation and capability state.
3. Missing permissions are reported as structured data.
4. User calls `spores permissions request`.
5. Native onboarding UI opens with explicit rows per permission.
6. Broker opens the relevant macOS Settings panes where possible.
7. User grants permissions manually.
8. Broker runs probes:
   - capture one frame
   - inspect focused app accessibility tree
   - optionally detect click metadata
9. Broker writes final capability snapshot.

## Agent-Facing Errors

```json
{
  "error": "missing_permission",
  "permission": "accessibility",
  "platform": "macos",
  "message": "Accessibility permission is required to record UI structure.",
  "requires_user_action": true,
  "retriable": true
}
```

## Installer Scope

The installer should install only user-level assets in v0:

```text
~/Applications/Spores Recorder.app
~/Library/Application Support/Spores/
```

Do not install a SecurityAgent authorization plugin in v0. Locked-screen
recording or control should only be added after a separate product and security
review.

## Tests

- Probe returns missing permissions on a clean system.
- Probe returns granted permissions after onboarding.
- Doctor output is valid JSON.
- Installer is idempotent.
- Uninstall removes user-level assets but preserves run bundles unless asked.

## MVP Milestones

1. `spores doctor --json`.
2. Native permission window.
3. Screen Recording probe.
4. Accessibility probe.
5. Idempotent helper install/update.
