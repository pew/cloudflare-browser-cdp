---
name: cloudflare-browser-handoff
description: Use when a user asks to take over, control, use, view, or interact with the current browser, or when login, MFA, CAPTCHA, or verification needs human input.
---

# Cloudflare Browser Handoff

Hand the current page to a person through Browser Run Live View, then resume in the same browser session. This is human intervention, not a bot-challenge bypass.

## Prerequisite

Require an active Browser Run connection and a tool that can send arbitrary CDP methods to a page target.

- Hermes: use `browser_cdp(method=..., params=..., target_id=...)`.
- OpenClaw: use a raw-CDP tool or plugin with the configured remote CDP profile; the high-level `browser` actions alone cannot send `Cloudflare.*` methods.
- Other runtimes: adapt the calls below to their raw-CDP tool.

If arbitrary CDP is unavailable, state that requirement and stop. Do not invent a handoff action.

## Live View delivery

Call the standard `Cloudflare.getLiveView` command. This proxy replaces Cloudflare's JWT-bearing URL with a short-lived same-origin link that redirects the user to Live View, so it remains shareable through agent chat without exposing the JWT to the agent runtime.

## Procedure

1. Stop automated input. Call `Target.getTargets` and select the `page` target matching the blocked page. If the title and URL do not identify one target uniquely, ask the user which page to use and do not guess. Route every `Cloudflare.*` call through that page target or its attached CDP session.
2. Call `Cloudflare.getHandoffState` with no parameters. If a handoff is already active, do not create another; subscribe if possible and continue waiting, with a local 10-minute deadline unless the user supplied a shorter one.
3. When the runtime exposes persistent CDP events, subscribe to `Cloudflare.handoffComplete` before starting the handoff.
4. Call `Cloudflare.getLiveView` with:

   ```json
   {"mode":"tab","expiresInMs":300000}
   ```

5. If no handoff was active, call `Cloudflare.handoff` with specific instructions for the user and a bounded timeout:

   ```json
   {"instructions":"Complete the verification, then select Done.","timeout":600000}
   ```

6. Immediately give the returned `devtoolsFrontendUrl` to the user. Keep the CDP and browser session open. Do not navigate, click, type, or close the page during handoff.
7. Wait for completion:
   - Event-capable runtime: inspect `Cloudflare.handoffComplete`; continue only when `success` is true, otherwise report `reason`.
   - Stateless raw-CDP tool: poll `Cloudflare.getHandoffState` every few seconds until `active` is false or the applicable timeout or local deadline expires. Then verify the task-specific success state; inactive alone does not prove success.
8. Re-run `Target.getTargets`, select the current page target, inspect its URL/content, and resume only if the requested human step succeeded.

## Safety

Treat the Live View URL as a short-lived bearer credential: show it only to the intended user and never log, store, or repeat it after completion. Browser Run remains identifiable as bot traffic, so handoff may not satisfy a site's policy; report that outcome plainly.
