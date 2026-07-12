# PlatformAdapter contract draft

## Purpose

`PlatformAdapter` isolates platform-specific call creation, authentication and replacement-link behavior from control-message transport and session orchestration. The interface is intentionally a draft until the official VK POC is complete.

## Design rules

- `SessionManager` works with stable session IDs and capabilities, not VK/Telemost/WB/DION conditionals.
- Adapter methods are idempotent where possible and accept an explicit cancellation/deadline context.
- Secrets are referenced through privileged handles; they are not returned to renderer/UI code.
- Operational links are typed sensitive values and never reused as diagnostic strings.
- Errors use stable categories plus redacted diagnostics.
- Capability differences are reported explicitly.

## TypeScript sketch

```ts
export type PlatformId = 'vk' | 'telemost' | 'wbstream' | 'dion';

export interface OperationContext {
  requestId: string;
  deadlineMs: number;
  signal: AbortSignal;
}

export interface PlatformCapabilities {
  canCreate: boolean;
  canJoinExisting: boolean;
  canReplaceLink: boolean;
  supportsDataChannel: boolean;
  supportsVideoTunnel: boolean;
  requiresInteractiveLogin: boolean;
}

export interface SessionRequest {
  sessionId: string;
  requestedMode: 'dc' | 'video' | 'headless';
  joinTarget?: SensitiveJoinTarget;
}

export interface SensitiveJoinTarget {
  readonly kind: 'join-target';
  readonly value: string;
}

export interface PlatformSession {
  sessionId: string;
  platformSessionId?: string;
  linkRevision: number;
  joinTarget: SensitiveJoinTarget;
  capabilities: PlatformCapabilities;
}

export type PlatformErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'CAPTCHA_REQUIRED'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UNSUPPORTED'
  | 'PLATFORM_REJECTED'
  | 'INTERNAL';

export interface PlatformFailure {
  code: PlatformErrorCode;
  retryable: boolean;
  safeMessage: string;
}

export interface PlatformAdapter {
  readonly id: PlatformId;

  capabilities(): Promise<PlatformCapabilities>;

  createSession(
    context: OperationContext,
    request: SessionRequest,
  ): Promise<PlatformSession>;

  replaceJoinTarget(
    context: OperationContext,
    session: PlatformSession,
  ): Promise<PlatformSession>;

  closeSession(
    context: OperationContext,
    session: PlatformSession,
  ): Promise<void>;

  health(
    context: OperationContext,
    session: PlatformSession,
  ): Promise<'starting' | 'ready' | 'degraded' | 'failed' | 'closed'>;
}
```

## Behavioral contract

### Idempotency

- Repeating `createSession` with the same authenticated `requestId` and request must not create duplicate platform sessions.
- A different request body with a reused `requestId` is rejected.
- `closeSession` succeeds when the target is already closed.

### Cancellation and deadlines

- Every long operation observes `AbortSignal` and the deadline.
- Cancellation is reported distinctly from timeout and platform rejection.
- Child processes spawned for a cancelled operation are cleaned up within a bounded interval.

### Sensitive values

- `joinTarget`, cookies, tokens and proxy credentials never appear in `safeMessage`, telemetry labels or default object serialization.
- A functional event carrying a `SensitiveJoinTarget` is delivered only to the authorized consumer.
- Diagnostic logs receive a redacted event generated independently from the functional event.

### Link replacement

- Each new usable link increments `linkRevision`.
- Consumers reject stale revisions.
- The adapter records enough platform state to close superseded sessions without exposing links to the control transport.

### Capabilities

The orchestrator branches on reported capabilities rather than platform names. Unsupported operations return `UNSUPPORTED` without launching a partial session.

## Out of scope for the POC

The POC does not instantiate this interface, start platform sessions or carry join links. The document exists to prevent the temporary VK transport experiment from becoming the permanent orchestration architecture.
