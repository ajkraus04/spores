# Agent Adapter SDK Plan

## Purpose

The Agent Adapter SDK lets agents and automation frameworks annotate recordings.
Native capture provides pixels and UI events. The SDK provides intent, expected
outcomes, observations, assertions, and tool metadata.

## Responsibilities

- Provide a small client library for agents.
- Emit structured annotations into active sessions.
- Support any runner or tool, not just Playwright.
- Redact sensitive arguments before persistence.
- Correlate annotations with native events and video timestamps.

## Non-Goals

- No desktop capture.
- No framework lock-in.
- No hidden chain-of-thought persistence.

## Supported Adapters

V0:

- Generic TypeScript client.
- Generic CLI event writer.

V1:

- Playwright adapter.
- Selenium/WebDriver adapter.
- Desktop-control adapter.
- Shell/terminal command adapter.
- Browser extension or CDP adapter, if needed.

## Core API

```ts
const spores = new SporesClient();

await spores.decision({
  intent: "Open billing settings",
  basis: ["billing link visible in sidebar"],
  expectedOutcome: "Billing settings page opens",
  confidence: "high",
});

await spores.action({
  tool: "computer_use.click",
  target: { app: "Example App", role: "button", label: "Billing" },
});

await spores.assertion({
  expected: "Billing page is visible",
  actual: "Billing heading appeared",
  status: "passed",
});
```

## Reasoning Policy

Do not store hidden chain-of-thought. Store user-visible rationale summaries:

- `intent`
- `basis`
- `selected_action`
- `expected_outcome`
- `alternatives_considered`
- `confidence`
- `tool_metadata`
- `provider_request_id`

## Event Shape

```json
{
  "type": "agent.decision",
  "event_id": "evt_123",
  "session_id": "sess_123",
  "monotonic_time_ns": 123456789,
  "payload": {
    "intent": "Open billing settings",
    "basis": ["billing link visible"],
    "expected_outcome": "Billing page opens",
    "confidence": "high",
    "hidden_cot_stored": false
  }
}
```

## Redaction

SDK clients should drop or hash:

- Passwords.
- API keys.
- Auth headers.
- Cookies.
- Environment variables.
- Full raw prompts unless explicitly allowed.
- Full request/response bodies unless allowlisted.

## Tests

- Events validate against schema.
- Redaction removes configured paths.
- SDK can write annotations without a running recording and receives a clear
  `no_active_session` error.
- Adapter events align with session clock.

## MVP Milestones

1. Shared schema package.
2. TypeScript SDK.
3. CLI `spores event append`.
4. Event correlation in viewer.
5. Playwright adapter as proof that frameworks are optional.
