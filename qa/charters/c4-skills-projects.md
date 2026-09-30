# c4-skills-projects: skills and projects

Goal: skills and projects work end to end for a new user, including edge cases.

Start state: fresh user, desktop viewport, fake AI (select "Opus 5").

1. Skills (Settings → Skills, the "Add a skill" button on the chat home, and the slash (`/`) popup in the composer):
   create, edit, disable and enable, delete, and reorder if the UI allows it. Reload after every change.
   Edge cases for each form: empty name, a 300-character name, emoji and right-to-left text, duplicate names, a
   double click on Create, cancelling halfway, the back button during an edit, very long instructions. If a skill has
   dependents, check the dependents dialog.
2. Projects (sidebar → Projects): create one with instructions, rename it, edit the instructions, delete it. Same edge
   cases; reload after each change.
3. Chats in projects: start a chat and send one message, move it into a project, then into another project, then out
   of the project; reload after each move. Delete a project that still has chats.

Out of bounds: account deletion, sign out, settings unrelated to skills and projects.

Budget: about 200 tool calls.
