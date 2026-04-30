-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

ALTER TABLE "powersync"."chat_messages" DROP CONSTRAINT "chat_messages_chat_thread_id_chat_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "powersync"."chat_messages" DROP CONSTRAINT "chat_messages_parent_id_chat_messages_id_fk";
