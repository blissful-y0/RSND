# Multi-Device Sync Test Scenarios

Related fix: visibility-change pull + rebase merge bug fix

## Scenario 1: Basic Multi-Device Switch (Core)

1. **Device A**: chat a few turns with a character
2. Hide tab (switch tab or minimize browser) -> flush triggers
3. **Device B**: open same server -> verify A's conversation is visible
4. **Device B**: add 2-3 more turns
5. **Device A**: re-activate tab
6. **Verify**: B's added turns appear on A

## Scenario 2: Both Devices Changed (Merge)

1. **A**: chat with character X -> hide tab
2. **B**: chat with character Y (different character)
3. **A**: re-activate tab
4. **Verify**: both A's character X chat and B's character Y chat are preserved

## Scenario 3: Settings Preserved

1. **A**: change settings (theme, preset, etc.) -> hide tab
2. **B**: only chat (don't touch settings)
3. **A**: re-activate tab
4. **Verify**: A's setting changes retained + B's conversation reflected

## Scenario 4: No Changes (304 Fast-Path)

1. **A**: open and leave idle -> hide tab
2. **B**: no changes either
3. **A**: re-activate tab
4. **Verify**: no unnecessary save triggered (Network tab: `/api/read` returns 304, no subsequent `/api/write` or `/api/patch`)

## Scenario 5: Same-Browser Tabs (Existing Behavior)

1. Open 2 tabs in the same browser
2. **Verify**: BroadcastChannel "active tab change" alert still works normally

## Scenario 6: Save In-Flight During Tab Switch

1. **A**: chat and immediately hide tab (while save is still in-flight)
2. **B**: chat a few turns
3. **A**: re-activate tab
4. **Verify**: no data loss — conflict goes through rebase path

## How to Verify

- **Console**: watch for `[Save]` prefixed logs
- **Network tab**: check `/api/read` requests have `If-None-Match` header, expect 304 (unchanged) or 200 (changed)
- **UI**: conversation and settings reflect the merged state after tab re-activation
