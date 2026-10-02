# c4-skills-projects: skills and projects

Goal: skills and projects work end to end for a new user, including edge cases.

Start state: fresh user, desktop viewport, fake AI (select "Opus 5").

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
2. Projects (sidebar → Projects): create one with instructions, rename it, edit the instructions, delete it. Same edge
   cases; reload after each change. Functions: `project-create`, `project-rename`, `project-instructions`,
   `project-delete`, `project-invalid-input`.
3. Chats in projects: start a chat and send one message, move it into a project, then into another project, then out
   of the project; reload after each move. Delete a project that still has chats. Functions: `chat-move`,
   `project-delete-with-chats`.

Out of bounds: account deletion, sign out, settings unrelated to skills and projects. How project instructions change
a real reply belongs to c5.
