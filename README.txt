Device Watchdog keeps an eye on all your Homey devices so you don't have to - low battery, devices that stopped reporting, and devices that became unreachable, all in one place.

WHAT IT MONITORS
- Battery level (percentage or battery alarm), with a global threshold and per-device overrides
- Devices that haven't sent any new data within a configurable time window ("not reporting")
- Devices Homey itself reports as unavailable, tracked in realtime

HOW IT WORKS
- Every device is monitored by default - no manual setup needed to get started
- Exclude individual devices, or a whole zone in one click, right from the Settings page
- Per-device overrides for battery threshold and reporting window, for the devices that need different rules
- A "Test" button lets you manually re-check whether a controllable device (on/off, dimmer) is actually reachable
- A built-in log keeps a running history of every detected problem and test result, so you can trace back what happened and when
- Optional Homey Timeline entries when a device newly becomes a problem - no repeat spam while the same problem persists

FLOW CARDS
- Per-device triggers ("battery gets low", "stops reporting", "becomes unavailable") with a device picker, for building flows around one specific device
- Summary triggers that fire once per batch with a count and device list, for when many devices are affected at once
- Condition cards to check a specific device's current status from any flow
- Action card to run a scan on demand

Fully bilingual settings UI (German/English), dark mode support, and zone-grouped device list that surfaces problem zones first.
