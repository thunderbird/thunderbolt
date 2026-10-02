# c4-skills-projects: skills and projects

Goal: skills and projects work end to end for a new user, including edge cases, and really change the AI's replies.

Start state: fresh user, desktop viewport. In this charter the AI is **real**: select "Opus 5"; replies vary. Keep
prompts short and send at most 10 chat messages in total.

Fill every required field each time you create or edit: a skill needs a name, a description and instructions (the
slug fills itself from the name), a project needs a name. When a form does not save, read its validation message,
fix the input and retry. A form that refuses to save without a message saying why, or with an unclear one, is a
finding (`assert-failed`): quote the form's fields and its disabled button.

1. Skills (Settings → Skills, the "Add a skill" button on the chat home, and the slash (`/`) popup in the composer):
   create, edit, disable and enable, delete, and reorder if the UI allows it. Reload after every change.
   Edge cases for each form: empty name, a 300-character name, emoji and right-to-left text, duplicate names, a
   double click on Create, cancelling halfway, the back button during an edit, 2,000-character instructions. If a
   skill has dependents, check the dependents dialog. Functions: `skill-create`, `skill-create-home`, `skill-edit`,
   `skill-toggle`, `skill-delete`, `skill-reorder`, `skill-slash`, `skill-invalid-input`.
2. Skills in replies. Give each skill you chat with instructions that set a checkable rule with a made-up marker
   word of its own, for example "End every reply with the word Abacaxi." Each chat below is a new one, and each
   message is a neutral question ("Say hello in one sentence."). Check the reply for the marker.
   - Pick the skill from the slash popup and send. Function: `skill-reply-slash`.
   - Add a skill with the home "Add a skill" button (its New Skill, or pin an existing one), click the skill's chip
     and send. Function: `skill-reply-home`.
   - Disable the skill and send the same message with its `/slug` typed by hand (press Escape if the popup opens);
     then delete it and do it again. The marker must be gone both times. Function: `skill-off-reply`.
3. Projects (sidebar → Projects): create one with instructions, rename it, edit the instructions, delete it. Same edge
   cases; reload after each change. Functions: `project-create`, `project-rename`, `project-instructions`,
   `project-delete`, `project-invalid-input`.
4. Project instructions in replies: give a project the instruction "End every reply with the word …" with another
   marker of your own, start a chat in it and send a neutral question. Function: `project-instructions-reply`.
5. Chats in projects: start a chat and send one message, move it into a project, then into another project, then out
   of the project; reload after each move. Delete a project that still has chats. Functions: `chat-move`,
   `project-delete-with-chats`.

A marker word lives only in the instructions of its skill or project. Never put it in a name, a description or a
message, and never use the chip's "Add instructions to chat", which pastes the instructions into your message:
the reply must show the marker because the app passed the instructions on. A reply without the marker, or one that
still shows it after the skill is off, is an `assert-failed` finding: quote the reply.

Specs for this charter replay against the same real providers, three times each, and two failures confirm a
finding. A spec creates the skill or project as you did, sends the same message, waits for the reply to finish as
an `ai-reported-failure` spec does, and checks the marker with a case-insensitive regex, never the rest of the
wording.

Out of bounds: account deletion, sign out, settings unrelated to skills and projects.
