import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { generateEmbeddings } from '@/lib/embeddings'
import { useState } from 'react'

export default function GenerateEmbeddingsSection() {
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [batchSize, setBatchSize] = useState<number>(100)
  const [status, setStatus] = useState<string>('')

  const handleGenerateEmbeddings = async () => {
    setIsGenerating(true)
    setStatus('Generating embeddings...')
    try {
      await generateEmbeddings(batchSize)
      setStatus('Embeddings generated successfully!')
    } catch (error) {
      console.error('Error generating embeddings:', error)
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generate Embeddings</CardTitle>
        <CardDescription>Generate embeddings for email messages in the database</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <Button onClick={handleGenerateEmbeddings} disabled={isGenerating}>
            {isGenerating ? 'Generating...' : 'Generate Embeddings'}
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">Batch Size:</span>
            <input type="number" value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} className="w-20 p-1 text-sm border rounded" min="1" max="1000" disabled={isGenerating} />
          </div>
        </div>

        {status && (
          <div className="mt-4 p-4 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm">{status}</div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
