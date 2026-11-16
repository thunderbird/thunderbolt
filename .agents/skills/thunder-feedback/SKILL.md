---
name: thunder-feedback
description: File feedback about Thunderbolt as a GitHub issue labeled `feedback` in thunderbird/thunderbolt. Use when the user wants to send, report or submit feedback.
---

Submit feedback about Thunderbolt as a public GitHub issue.

1. The feedback is the text after the skill name. If it is empty, ask the user for it in chat and wait.
2. Compose the issue:
   - **Title**: a short summary under 80 characters.
   - **Body**: the full feedback, prefixed with "Submitted via `thunder-feedback`".
3. The repository is public: show the title and body to the user and create the issue only after they confirm.
4. Make sure the label exists:
   ```bash
   gh label create feedback --description "User feedback submitted via thunder-feedback" --color "0E8A16" --repo thunderbird/thunderbolt 2>/dev/null || true
   ```
5. Create the issue:
   ```bash
   gh issue create --repo thunderbird/thunderbolt --title "<title>" --body "<body>" --label feedback
   ```
6. Report the issue URL.
