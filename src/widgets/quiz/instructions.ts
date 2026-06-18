/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const instructions = `## Quiz
<widget:quiz mode="MODE" prompt="QUESTION" options='JSON_ARRAY' explanation="WHY" />
An interactive multiple-choice quiz the user can answer inline. Prefer this over a markdown list whenever you ask the user a multiple-choice question.
- mode: "single" (exactly one correct answer), "multiple" (one or more correct answers), or "choice" (no correct answer — an open prompt like "What do you want to do next?")
- prompt: the question or prompt text
- options: a JSON array wrapped in SINGLE quotes. Each option is {"id":"a","text":"..."}; for graded modes add "isCorrect":true to correct options. Never set isCorrect in "choice" mode.
- explanation (optional): a short note shown after the user answers (graded modes only)
Emit one widget per question. Do not also list the answers in text — the widget reveals them.
Example: <widget:quiz mode="single" prompt="What is the capital of France?" options='[{"id":"a","text":"Paris","isCorrect":true},{"id":"b","text":"Lyon"},{"id":"c","text":"Marseille"}]' explanation="Paris has been France's capital since 508 AD." />`
