# c6-settings-data: settings and your data

Goal: every preference sticks, and exporting and importing data keeps it intact.

Start state: fresh user, desktop viewport, fake AI (select "Opus 5").

1. Settings → Preferences: change the preferred name, theme, language (switch to another language, look around, switch
   back), distance and temperature units, time format, currency and location. Reload after each change.
   Edge cases: an empty and a 300-character name, clearing the location, fast repeated toggles.
2. Toggle data collection (telemetry) and any proxy or privacy switch; reload and check each.
3. Create some data (two chats, a skill), export your data, delete the local data, import the export, and check
   everything came back.
4. Settings → Devices: check this device is listed and what the page offers.
5. Visit every other settings page once and check it loads.

Out of bounds: account deletion, sign out.
