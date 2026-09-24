# Mem0 Gateway connector (read only)

Owner decision 8 on venturi-systems/landing-page#2309 (2026-09-23) adds
`feedback.venturi.systems` to the Mem0 Gateway as a read-only MCP connector,
after the administrator cutover. This page is the key preset and the steps.

## What the connector can do

| Decision | MCP tools                                                        |
| -------- | ---------------------------------------------------------------- |
| Granted  | `search`, `get_details`, `get_post_activity`, `list_suggestions` |
| Denied   | every other tool                                                 |

Two independent controls keep it read-only:

1. **The key.** The "Mem0 Gateway connector (read only)" preset creates a key
   with the single scope `read:feedback`. Every write tool checks
   `write:feedback` (or `write:changelog`, `write:article`, `write:chat`)
   and refuses this key, even if a Gateway grant were widened by mistake.
2. **The Gateway grants.** The connector grants only the four tools above.

No key and no MCP client can change a post's status, whatever its scopes:
a status change emails subscribers, so only a signed-in team member makes one
in the admin inbox. A key also acts with its creator's current role and never
more, so a key stops working for team data if its creator loses the team role.

## Create the key (an administrator, signed in with Google or GitHub)

1. Admin > Settings > Developers > API Keys > Create Key.
2. Name: `mem0-gateway-agents`.
3. Access: **Mem0 Gateway connector (read only)**.
4. Expires: **In 90 days**. Every key expires; the longest choice is 365 days.
5. Copy the key once. It is shown only at creation.

The key never passes through an agent transcript: the owner pastes it into the
Gateway credential field himself.

## Register the connector (Gateway console, owner)

1. Connectors > Add > kind **MCP**.
2. URL: `https://feedback.venturi.systems/api/mcp`.
3. Credential: **Bearer**, the key from above.
4. Test MCP, then Sync tools.
5. Grant `read` on `search`, `get_details`, `get_post_activity` and
   `list_suggestions` only. Grants are a full replace: read the current
   grants, edit, write them back.

Developers > MCP must be on. Leave "Portal user MCP access" off.

## Verify (an agent)

- `find_tools(task="search feedback portal")` returns the connector's
  `search` tool, and a read-only `invoke` succeeds.
- A denied tool answers `out_of_scope` from the Gateway.
- A write tool reached another way answers "Insufficient scope" (required
  scope `write:feedback`) from the portal.

## Rotate or revoke

Rotate before the expiry (Developers > API Keys > rotate), paste the new key
into the Gateway credential field, and confirm one read call. Revoking the key
in the portal stops the connector at once.

## Data flow

Every granted call passes feedback content through Mem0's infrastructure,
including the protected boards a team key can read. The owner's decision 8
authorizes this for read-only access only.
