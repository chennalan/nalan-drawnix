# Drawnix Cloud Autosave Implementation Plan

## Current behavior

The web app in `apps/web/src/app/app.tsx` persists the active board to browser storage using `localforage` with IndexedDB and localStorage fallback. This remains the offline/local recovery layer.

## Target behavior

- Sign in before enabling cloud sync.
- List, open, rename, and delete the signed-in user's documents.
- Debounced autosave after board changes, with visible states: local only, saving, saved, and sync failed.
- Keep local changes when offline or when the cloud API fails.
- Never put Cloudflare API tokens, R2 credentials, or other service secrets in browser code.
- Isolate each user's document records and object keys on the server.
- Validate request size, document IDs, titles, JSON shape, and ownership server-side.
- Provide explicit conflict/version handling so an older tab cannot silently overwrite a newer revision.

## Proposed Cloudflare architecture

- Cloudflare Pages serves the existing Drawnix web app.
- Cloudflare Access provides identity (email one-time PIN or another configured login method) and protects the app/API. The API must validate Access JWTs, not trust arbitrary identity headers.
- A dedicated Cloudflare Worker handles document API requests and validates the Access JWT.
- D1 stores document metadata (id, owner email/subject, title, object key, revision, created_at, updated_at).
- A private R2 bucket stores document JSON payloads. Object keys are generated server-side and scoped by user/document IDs.
- The worker accesses D1/R2 via bindings. The browser only calls the API and never receives storage credentials.

## Safe rollout sequence

1. Preserve the production `develop` branch and existing Pages projects.
2. Implement and review the cloud API and client integration on `feature/cloud-autosave`.
3. Confirm the R2 bucket/account access and choose a dedicated bucket or explicitly approve reuse of `nalan-backup`. Do not expose a public R2 domain.
4. Provision only new, clearly named resources after reviewing the final resource list.
5. Deploy a preview/test API and test authentication, ownership isolation, autosave, offline recovery, version conflicts, and document deletion.
6. Deploy production only after preview tests pass.

## Current infrastructure findings

- Pages project `nalan-drawnix` exists and is connected to GitHub.
- Existing Pages projects include `nalan-tool`, `nalan-website`, `nalan-work`, and `nalan-mindmap`; this work must not alter them.
- D1 databases currently visible to the connected account are `nalan-mindmap` and `nalan-work`. Do not reuse either database for Drawnix without an explicit schema/ownership review.
- The Cloudflare R2 bucket-list endpoint returned HTTP 403 stating R2 must be enabled in the dashboard. The remembered bucket `nalan-backup` therefore cannot yet be verified or safely bound through the current API connection.
- No cloud autosave backend or login flow is considered implemented until API authorization and end-to-end tests pass.
