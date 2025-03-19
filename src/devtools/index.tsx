import GenerateEmbeddingsSection from './generate-embeddings'
import ImapMailboxesSection from './imap-mailboxes-section'
import ImapSyncSection from './imap-sync-section'

export default function DevToolsPage() {
  return (
    <>
      <div className="flex flex-col gap-6 p-6 w-full">
        <h1 className="text-3xl font-bold">Dev Tools</h1>
        <p className="text-gray-600 dark:text-gray-400">These tools are only visible during development.</p>

        <div className="grid gap-6">
          <ImapSyncSection />
          <ImapMailboxesSection />
          <GenerateEmbeddingsSection />
        </div>
      </div>
    </>
  )
}
