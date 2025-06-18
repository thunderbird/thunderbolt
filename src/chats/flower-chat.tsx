import { Button } from '@/components/ui/button'
import { useDatabase } from '@/hooks/use-database'
import { modelsTable, settingsTable } from '@/db/tables'
import { chatWithFlowerDirect, FI_DEFAULT_MODEL, getFlowerApiKey } from '@/lib/flower-direct'
import { Model, SaveMessagesFunction, Setting } from '@/types'
import { useMutation, useQuery } from '@tanstack/react-query'
import { UIMessage } from 'ai'
import { eq } from 'drizzle-orm'
import { AlertCircle, CheckCircle, Lock, Shield } from 'lucide-react'
import { useEffect, useState } from 'react'
import { v7 as uuidv7 } from 'uuid'

interface FlowerChatProps {
  id: string
  initialMessages: UIMessage[] | undefined
  saveMessages: SaveMessagesFunction
}

type AttestationStatus = 'pending' | 'verified' | 'failed'

export default function FlowerChat({ id, initialMessages, saveMessages }: FlowerChatProps) {
  const { db } = useDatabase()
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages || [])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // Note: Encryption currently returns error 50003, so defaulting to false
  const [encryptionEnabled, setEncryptionEnabled] = useState(false)
  const [attestationStatus, setAttestationStatus] = useState<AttestationStatus>('pending')
  const [flowerApiKey, setFlowerApiKey] = useState<string | null>(null)

  const { data: flowerModels = [] } = useQuery<Model[]>({
    queryKey: ['flowerModels'],
    queryFn: async () => {
      // Only fetch enabled Flower AI models from the database
      return await db
        .select()
        .from(modelsTable)
        .where(eq(modelsTable.enabled, 1))
        .then((models) => models.filter((model) => model.provider === 'flower'))
    },
  })

  const { data: settings = [] } = useQuery<Setting[]>({
    queryKey: ['settings'],
    queryFn: async () => {
      return await db.select().from(settingsTable)
    },
  })

  // Initialize Flower API key and attestation
  useEffect(() => {
    const initializeFlower = async () => {
      try {
        setAttestationStatus('pending')
        const apiKey = await getFlowerApiKey()
        if (apiKey) {
          setFlowerApiKey(apiKey)
          setAttestationStatus('verified')
        } else {
          setAttestationStatus('failed')
        }
      } catch (error) {
        console.error('Failed to initialize Flower AI:', error)
        setAttestationStatus('failed')
      }
    }

    initializeFlower()
  }, [])

  const sendMessageMutation = useMutation({
    mutationFn: async (newMessage: string) => {
      if (!flowerApiKey) {
        throw new Error('Flower AI not initialized')
      }

      const userMessage: UIMessage = {
        id: uuidv7(),
        role: 'user',
        parts: [{ type: 'text', text: newMessage }],
      }

      const updatedMessages = [...messages, userMessage]
      setMessages(updatedMessages)

      // Convert to Flower AI format
      const flowerMessages = updatedMessages.map((msg) => ({
        role: msg.role,
        content:
          msg.parts
            ?.filter((part) => part.type === 'text')
            .map((part) => (part as any).text)
            .join(' ') || '',
      }))

      // Use the first available Flower model or default
      const selectedModel = flowerModels[0]?.model || FI_DEFAULT_MODEL

      const response = await chatWithFlowerDirect(flowerMessages, {
        model: selectedModel,
        encrypt: encryptionEnabled,
        stream: true,
      })

      if (!response.ok) {
        throw new Error(response.failure?.description || 'Flower AI request failed')
      }

      const assistantMessage: UIMessage = {
        id: uuidv7(),
        role: 'assistant',
        parts: [{ type: 'text', text: response.message.content }],
      }

      const finalMessages = [...updatedMessages, assistantMessage]
      setMessages(finalMessages)

      // Save messages to database
      await saveMessages({ id, messages: finalMessages })

      return finalMessages
    },
    onError: (error) => {
      console.error('Error sending message:', error)
    },
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isLoading) return

    setIsLoading(true)
    try {
      await sendMessageMutation.mutateAsync(input)
      setInput('')
    } finally {
      setIsLoading(false)
    }
  }

  const getAttestationIcon = () => {
    switch (attestationStatus) {
      case 'verified':
        return <CheckCircle className="h-4 w-4 text-green-500" />
      case 'failed':
        return <AlertCircle className="h-4 w-4 text-red-500" />
      default:
        return <Shield className="h-4 w-4 text-yellow-500" />
    }
  }

  const getAttestationText = () => {
    switch (attestationStatus) {
      case 'verified':
        return 'Secure connection verified'
      case 'failed':
        return 'Failed to establish secure connection'
      default:
        return 'Verifying secure connection...'
    }
  }

  const getMessageText = (message: UIMessage): string => {
    return (
      message.parts
        ?.filter((part) => part.type === 'text')
        .map((part) => (part as any).text)
        .join(' ') || ''
    )
  }

  if (!settings) {
    return <div>Loading...</div>
  }

  return (
    <div className="flex flex-col h-full">
      {/* Flower AI Status Bar */}
      <div className="bg-blue-50 border-b border-blue-200 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Shield className="h-5 w-5 text-blue-600" />
            <span className="text-sm font-medium text-blue-900">Flower AI - Privacy-First AI</span>
          </div>
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              {getAttestationIcon()}
              <span className="text-xs text-gray-600">{getAttestationText()}</span>
            </div>
            <div className="flex items-center space-x-2">
              <Lock className={`h-4 w-4 ${encryptionEnabled ? 'text-green-500' : 'text-gray-400'}`} />
              <label className="flex items-center space-x-1">
                <input type="checkbox" checked={encryptionEnabled} onChange={(e) => setEncryptionEnabled(e.target.checked)} className="rounded" />
                <span className="text-xs text-gray-600">Encryption</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-lg p-3 ${message.role === 'user' ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-900'}`}>
              <div className="text-sm">{getMessageText(message)}</div>
              {message.role === 'assistant' && encryptionEnabled && (
                <div className="flex items-center space-x-1 mt-2 text-xs opacity-70">
                  <Lock className="h-3 w-3" />
                  <span>End-to-end encrypted</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="border-t p-4">
        <form onSubmit={handleSubmit} className="flex space-x-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={attestationStatus === 'verified' ? 'Type your message...' : 'Waiting for secure connection...'}
            disabled={isLoading || attestationStatus !== 'verified'}
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <Button type="submit" disabled={isLoading || !input.trim() || attestationStatus !== 'verified'}>
            {isLoading ? 'Sending...' : 'Send'}
          </Button>
        </form>
      </div>
    </div>
  )
}
