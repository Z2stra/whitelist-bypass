# VK control-plane improvement plan v2 — repository summary

## Purpose

This summary translates the supplied v2.0 implementation plan into repository milestones. `PRODUCT.md` is the authoritative live checklist; this document explains ordering and non-goals.

## Required order

```text
Phase 0 documentation and baseline
        ↓
Pre-POC security gate
        ↓
Official VK API PING/PONG POC
        ↓
Explicit GO / NO-GO
        ↓ only after GO
Production security foundation
        ↓
WLB2 and pairing
        ↓
PlatformAdapter implementations
        ↓
SessionManager and registries
        ↓
Android control UX and recovery
        ↓
Cross-platform packaging/release validation
```

## Why the POC is mandatory

The proposed architecture depends on an Android token obtained through the official VK ID path being authorized for the required messaging methods, and on those methods working reliably in the target network. Building encryption, pairing and session orchestration first would not reduce this fundamental risk.

The POC therefore carries only a random PING/PONG correlation pair. It does not start a call, transport a join link, manage cookies, control a proxy or create a production protocol commitment.

## Windows v1 scope

- Existing Electron Creator is the only Windows host.
- Existing VK bot code is refactored into a transport boundary before it receives real credentials.
- The standalone Go VK bot is not developed as a parallel WLB2 server during this phase.
- A future `SessionManager` consumes typed platform-neutral adapters rather than chat commands.

## Security sequencing

Some items originally grouped as later hardening are prerequisites for the POC because real credentials would otherwise cross an unsafe boundary. At minimum, the POC requires:

- no token/settings/request-key leakage;
- mandatory identity and private-dialog checks;
- bounded/cancellable HTTP and Long Poll lifecycle;
- POC-only parser isolated from operational commands;
- reviewed Electron IPC/webview boundary;
- reviewed Android token storage, logs and backup behavior.

This is a sequencing clarification, not a claim that all production security work is complete before the POC.

## Quality policy

Every code milestone includes tests and the applicable build/lint/vet commands. Existing upstream errors are recorded and fixed or explicitly scoped; they are not hidden using global suppression or an unreviewed baseline.

## Major non-goals before GO

- Production WLB2 cryptography.
- QR pairing and key recovery.
- Session/capability registries.
- Full multi-platform adapter rollout.
- Replacement-link automation.
- New Windows service/daemon.
- Use of unofficial or extracted VK user tokens.

## Evidence and decisions

POC evidence is recorded in `docs/poc/vk-api-poc-results.md`. A GO/NO-GO decision must name the tested commit, environment, granted scope, repeated-exchange result, lifecycle result and target-network result without publishing credentials or private identifiers.
