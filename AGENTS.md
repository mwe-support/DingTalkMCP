# AGENTS.md

## Scope

These instructions apply to the entire `approval-mcp` repository.

## Agent-facing tool design

- Design public MCP tools around a business role and one coherent state machine, not around DingTalk OpenAPI endpoints.
- Prefer a deep tool with a small, stable interface. Keep OpenAPI calls, attachment authorization/link-exchange steps, compatibility aliases, and HTTP action routes behind that interface as internal adapters.
- Operations that share the same actor, authorization boundary, primary identifier, and lifecycle belong in one tool. Use a discriminated `action` field and action-specific validation instead of publishing one tool per verb.
- For the approver role, the target public interface is one `approval_task` tool with `action: "view" | "approve" | "reject"`:
  - `view` returns normalized approval content, current actionable task state, operation records, attachment metadata, and bounded optional temporary download links.
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
- Attachment link preparation must be explicit and bounded by count, HTTPS protocol, and an approved host suffix list. Default to metadata rather than preparing links in bulk.
- The MCP server must not download attachment bytes, return Base64 attachment content, parse documents, or run OCR. Its attachment responsibility ends after it exchanges DingTalk identifiers for validated temporary links. The Agent client must download, identify, parse, and OCR files as needed.

## Mutation safety

- Require `confirm: true` for write actions and provide `dryRun` where a meaningful preflight can be returned.
- Before approving or rejecting, reread the approval instance, verify the task is still actionable, verify ownership/delegation for the bound caller, and reject stale task IDs.
- Keep process-code and write-user allowlists, idempotency protection, structured audit records, and secret-safe logs.
- A rejection must require a non-empty business reason unless a documented template policy explicitly permits an empty remark.
- Never log application secrets, bearer tokens, full approval forms, attachment contents, or temporary attachment download URLs.
- Record authenticated public tool invocations as structured, append-only JSONL with an anonymous invocation ID, bounded action enum, outcome, status, duration, and safe error code. Do not persist the request body or business identifiers in the invocation event.
- Keep production audit files for at most 30 UTC calendar days. Enforce cleanup at startup, after writes, and periodically while idle; do not duplicate retained audit events into unmanaged container stdout/stderr logs.
- Bound every retained audit write. If the start record cannot be persisted, do not execute the tool; if a completion or nested mutation record fails or times out after the business action, preserve the original business result and mark the invocation audit as partial rather than returning a retryable mutation error.

## Transport and deployment

- The authoritative production target is a self-hosted Streamable HTTP MCP endpoint at `https://dingtalk.mwexk.com/mcp` on the CVM. The DingTalk AIHub version has been deleted, and the project has abandoned DingTalk-hosted MCP transport. Do not describe `mcp-gw.dingtalk.com`, an AIHub-generated URL, or a platform `key` as the current or target client connection.
- The codebase implements OAuth-protected `/mcp`, OAuth discovery/authorization endpoints, DingTalk callback, and `/healthz`. Do not claim the public deployment is live until the exact CVM URL passes the protocol checks below.
- MCP client authentication applies only to the client-facing self-hosted `/mcp` endpoint. Keep it separate from DingTalk OpenAPI authentication.
- Use DingTalk OAuth only as the upstream identity provider for MCP client login. The self-hosted authorization layer must validate the DingTalk enterprise identity and then issue a short-lived, resource-bound MCP token. Never accept or forward a DingTalk `userAccessToken` as the `/mcp` Bearer token.
- Bind the verified `corpId + unionId + userId` to each Streamable HTTP request and inject it into the approval domain as an explicit caller context. Production `/mcp` must not derive identity from model input, a fixed `DINGTALK_CALLER_USER_ID`, cookies, query-string tokens, or unverified headers.
- MCP access tokens must use the canonical issuer and audience for `https://dingtalk.mwexk.com/mcp`, short expiry, explicit approval scopes, PKCE S256, and supported revocation/rotation semantics. Keep OAuth transaction and client-registration state behind a replaceable store Interface so a future multi-replica deployment can adopt a shared Adapter.
- DingTalk OpenAPI calls must continue to use the dedicated enterprise application's App ID/AppKey and App Secret/AppSecret to obtain and cache the application access token. Do not replace that upstream application identity with MCP client credentials or user OAuth merely because the MCP transport authentication changes.
- Do not expose or retain `/platform/tools/*`, `MCP_PLATFORM_API_KEY`, AIHub actions, or official-gateway compatibility routes. Requests to retired platform paths must return 404.
- Support Streamable HTTP only. Do not add or advertise a stdio transport.
- The only tool transport is the OAuth-protected `/mcp` endpoint. Health and OAuth endpoints are supporting HTTP routes, not alternate tool transports.
- Bind application containers to loopback unless traffic enters through an authenticated reverse proxy or tunnel. Store production secrets outside the repository with least-readable permissions.
- The current CVM production contract is `/public/cvm-web-edge/README.md`: systemd HAProxy owns public `80/443`, `edge-nginx` owns loopback `18080/18444`, and each local business container publishes one unique loopback backend port. Read and update that README in the same change whenever ports or routes change.
- `127.0.0.1:3000` is registered to the production DingTalk backend. A parallel candidate must use a separately verified free loopback port and register it in the edge README before activation; never bind a business backend to `0.0.0.0`.
- A shared external Docker network and bridge-mode container Router remain the approved future migration target for multiple Web services, not a prerequisite that may be switched for DingTalk alone. Inventory and test every local and WireGuard route before changing the current ingress topology.
- Treat WireGuard as an L3 connectivity adapter, not as the Web router. A service reached through WireGuard must appear to the container router as an explicit upstream and must not remain an implicit catch-all once its hostnames have been inventoried.
- The router must support both HTTP/TLS termination for local containers and TCP/TLS passthrough for legacy WireGuard upstreams during migration. Preserve the existing WireGuard route until every currently served hostname has an explicit tested route.
- Prefer bridge networking for application containers. Use `network_mode: host` only for an infrastructure adapter with a documented need, never as the default multi-service routing pattern.
- Stage a new router on non-production ports and test every local and WireGuard route before transferring host ports `80` and `443`. Keep a tested rollback to the previous ingress configuration.

## Verification

- Add contract tests for every action branch, conditional field rule, authorization failure, stale state, idempotency behavior, and attachment limit.
- Do not claim that a public MCP deployment works until `initialize`, `tools/list`, and at least one read call plus a dry-run write call have succeeded through the exact public URL.
