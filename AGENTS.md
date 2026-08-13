# AGENTS.md

## Scope

These instructions apply to the entire `approval-mcp` repository.

## Agent-facing tool design

- Design public MCP tools around a business role and one coherent state machine, not around DingTalk OpenAPI endpoints.
- Prefer a deep tool with a small, stable interface. Keep OpenAPI calls, attachment authorization/download steps, compatibility aliases, and HTTP action routes behind that interface as internal adapters.
- Operations that share the same actor, authorization boundary, primary identifier, and lifecycle belong in one tool. Use a discriminated `action` field and action-specific validation instead of publishing one tool per verb.
- For the approver role, the target public interface is one `approval_task` tool with `action: "view" | "approve" | "reject"`:
  - `view` returns normalized approval content, current actionable task state, operation records, attachment metadata, and bounded optional attachment content.
  - `approve` and `reject` perform the corresponding transition only after rereading and validating the current task.
  - Do not publish raw `get detail`, `list attachments`, `download attachment`, `approve`, and `reject` operations as separate primary tools.
- Keep applicant operations in a separate business tool, such as `approval_request`, because template selection, preparation, submission, and revocation use a different actor and lifecycle from approver actions.
- Do not create a generic catch-all approval tool that mixes unrelated roles, authorization rules, or state machines. Cohesion, not minimum tool count by itself, is the goal.
- A new public tool is justified only when its actor, authorization boundary, primary business object, or lifecycle is materially different and cannot fit an existing action union without weakening clarity or safety. Document that reason in the change.
- Diagnostic and compatibility operations may remain callable internally, but they must not expand the normal agent-facing tool list.

## Action contracts

- Model aggregated tools as discriminated unions so each action has precise required and forbidden fields.
- Inject caller and actor identity on the server. Never accept `actionerUserId`, applicant identity, or equivalent authority-bearing identifiers from untrusted model input.
- Return a consistent result envelope across actions, including the business object ID, action performed, current status, audit correlation ID, and safe next actions.
- Because MCP annotations are static, a tool that contains both read and write actions must be described and annotated conservatively as potentially mutating. The `view` action itself must remain side-effect-free.
- Attachment reads must be explicit and bounded by count, decoded-byte budget, allowed MIME types, and redaction rules. Default to metadata rather than bulk Base64 content.

## Mutation safety

- Require `confirm: true` for write actions and provide `dryRun` where a meaningful preflight can be returned.
- Before approving or rejecting, reread the approval instance, verify the task is still actionable, verify ownership/delegation for the bound caller, and reject stale task IDs.
- Keep process-code and write-user allowlists, idempotency protection, structured audit records, and secret-safe logs.
- A rejection must require a non-empty business reason unless a documented template policy explicitly permits an empty remark.
- Never log application secrets, bearer tokens, full approval forms, attachment contents, or temporary attachment download URLs.

## Transport and deployment

- Support Streamable HTTP only. Do not add or advertise a stdio transport.
- Keep the distinction explicit: `/platform/tools/*` routes are an HTTPS tool backend for the DingTalk MCP platform; they are not a Streamable HTTP MCP endpoint. A self-hosted MCP URL requires an actual `/mcp` transport, initialization, authentication, session handling, and protocol tests.
- Bind application containers to loopback unless traffic enters through an authenticated reverse proxy or tunnel. Store production secrets outside the repository with least-readable permissions.
- Implement the shared Web ingress and domain routing as a separately managed containerized router, rather than accumulating per-domain routing in a host-installed proxy.
- Put routable Web containers on one dedicated external Docker network. Application containers expose only their internal port to that network; only the router publishes host ports `80` and `443`.
- Route local containers by declared hostname and service port. Adding a Web service should normally require adding its container and route declaration, not editing unrelated application containers.
- Treat WireGuard as an L3 connectivity adapter, not as the Web router. A service reached through WireGuard must appear to the container router as an explicit upstream and must not remain an implicit catch-all once its hostnames have been inventoried.
- The router must support both HTTP/TLS termination for local containers and TCP/TLS passthrough for legacy WireGuard upstreams during migration. Preserve the existing WireGuard route until every currently served hostname has an explicit tested route.
- Prefer bridge networking for application containers. Use `network_mode: host` only for an infrastructure adapter with a documented need, never as the default multi-service routing pattern.
- Stage a new router on non-production ports and test every local and WireGuard route before transferring host ports `80` and `443`. Keep a tested rollback to the previous ingress configuration.

## Verification

- Add contract tests for every action branch, conditional field rule, authorization failure, stale state, idempotency behavior, and attachment limit.
- Do not claim that a public MCP deployment works until `initialize`, `tools/list`, and at least one read call plus a dry-run write call have succeeded through the exact public URL.
