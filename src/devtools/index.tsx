import EmbedderSettingsSection from './embedder-settings'
import GenerateEmbeddingsSection from './generate-embeddings'
import GenerateEmbeddingsFrontendSection from './generate-embeddings-frontend'
import GenerateEmbeddingsFrontendNoDatabaseSection from './generate-embeddings-no-database'
import GenerateEmbeddingsOptimizedSection from './generate-embeddings-optimized'
import ImapMailboxesSection from './imap-mailboxes-section'
import ImapSyncSection from './imap-sync-section'
import ResetEmailMessagesSection from './reset-email-messages'
import SearchSection from './search'

export default function DevToolsPage() {
  return (
    <>
      <div className="flex flex-col gap-6 p-6 w-full">
        <h1 className="text-3xl font-bold">Dev Tools</h1>
        <p className="text-gray-600 dark:text-gray-400">These tools are only visible during development.</p>

        <div className="grid gap-6">
          <ImapSyncSection />
          <ImapMailboxesSection />
          <ResetEmailMessagesSection />
          <GenerateEmbeddingsOptimizedSection />
          <EmbedderSettingsSection />
          <GenerateEmbeddingsFrontendNoDatabaseSection />
          <GenerateEmbeddingsFrontendSection />
          <GenerateEmbeddingsSection />
          <SearchSection />
        </div>
      </div>
    </>
  )
}
