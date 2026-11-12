---
name: thunderdown
description: Stop the Thunderbolt Docker containers for this checkout (make down), keeping their data volumes. Use when asked to stop the local stack or free its ports.
---

Run `make status`, then `make down`. Volumes survive; `make nuke` would delete them and is out of scope here. Confirm the containers stopped.
