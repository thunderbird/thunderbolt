Submit feedback about Thunderbolt as a GitHub issue.

**Steps:**

1. Get feedback from `$ARGUMENTS`. If empty, ask the user what feedback they'd like to submit.

2. Compose a concise issue:
   - **Title:** Short summary of the feedback (under 80 chars)
   - **Body:** The full feedback text, prefixed with: "Submitted via `/thunderfeedback`"

3. Ensure the `feedback` label exists:
   ```
   gh label create feedback --description "User feedback submitted via /thunderfeedback" --color "0E8A16" --repo thunderbird/thunderbolt 2>/dev/null || true
   ```

4. Create the issue:
   ```
   gh issue create --repo thunderbird/thunderbolt --title "<title>" --body "<body>" --label feedback
   ```

5. Report the created issue URL back to the user.
