# Current task

**Status: in progress**

PR133 — Client 401 → Clear Expired Keeper Session.

When an authenticated Keeper/admin API request receives HTTP 401, emit a central auth-rejected signal and hand the UI back to Guest Mode via the existing `handToGuest()` path (same result as manual Lock Bar and kiosk idle timeout).
