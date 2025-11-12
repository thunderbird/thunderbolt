import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ChatMessages } from './chat-messages'
import { useChatStore } from '@/chats/chat-store'
import type { Chat } from '@ai-sdk/react'
import type { ThunderboltUIMessage, ChatThread, AutomationRun } from '@/types'

// Mock child components
const mockAssistantMessage = mock()
const mockTriggerMessage = mock()
const mockUserMessage = mock()
const mockEncryptionMessage = mock()
const mockErrorMessage = mock()

mock.module('./assistant-message', () => ({
  AssistantMessage: (props: { message: ThunderboltUIMessage; isStreaming: boolean }) => {
    mockAssistantMessage(props)
    return <div data-testid="assistant-message">{props.message.id}</div>
  },
}))

mock.module('./trigger-message', () => ({
  TriggerMessage: (props: { chatThreadId: string; title?: string; prompt?: string; isDeleted?: boolean }) => {
    mockTriggerMessage(props)
    return <div data-testid="trigger-message">{props.title || 'Trigger'}</div>
  },
}))

mock.module('./user-message', () => ({
  UserMessage: (props: { message: ThunderboltUIMessage }) => {
    mockUserMessage(props)
    return <div data-testid="user-message">{props.message.id}</div>
  },
}))

mock.module('./encryption-message', () => ({
  EncryptionMessage: () => {
    mockEncryptionMessage()
    return <div data-testid="encryption-message">Encrypted</div>
  },
}))

mock.module('./error-message', () => ({
  ErrorMessage: (props: { message: string }) => {
    mockErrorMessage(props)
    return <div data-testid="error-message">{props.message}</div>
  },
}))

// Mock useChat
const mockUseChat = mock()

mock.module('@ai-sdk/react', () => ({
  useChat: mockUseChat,
}))

describe('ChatMessages', () => {
  const createMockMessage = (role: 'user' | 'assistant', content: string, id?: string): ThunderboltUIMessage => {
    return {
      id: id || `msg-${Date.now()}-${Math.random()}`,
      role,
      parts: [{ type: 'text', text: content }],
    } as ThunderboltUIMessage
  }

  const createMockChatInstance = (messages: ThunderboltUIMessage[]): Chat<ThunderboltUIMessage> => {
    return {
      messages,
      status: 'ready',
      sendMessage: mock(),
    } as unknown as Chat<ThunderboltUIMessage>
  }

  beforeEach(() => {
    useChatStore.getState().reset()
    mockUseChat.mockReset()
    mockAssistantMessage.mockReset()
    mockTriggerMessage.mockReset()
    mockUserMessage.mockReset()
    mockEncryptionMessage.mockReset()
    mockErrorMessage.mockReset()
  })

  describe('Basic rendering', () => {
    it('should render user and assistant messages', () => {
      const userMessage = createMockMessage('user', 'Hello')
      const assistantMessage = createMockMessage('assistant', 'Hi there!')
      const mockChatInstance = createMockChatInstance([userMessage, assistantMessage])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage, assistantMessage],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(screen.getByTestId('user-message')).toBeInTheDocument()
      expect(screen.getByTestId('assistant-message')).toBeInTheDocument()
      expect(mockUserMessage).toHaveBeenCalledWith({ message: userMessage })
      expect(mockAssistantMessage).toHaveBeenCalledWith({
        message: assistantMessage,
        isStreaming: false,
      })
    })

    it('should render only user messages', () => {
      const userMessage1 = createMockMessage('user', 'First message')
      const userMessage2 = createMockMessage('user', 'Second message')
      const mockChatInstance = createMockChatInstance([userMessage1, userMessage2])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage1, userMessage2],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      const userMessages = screen.getAllByTestId('user-message')
      expect(userMessages).toHaveLength(2)
      expect(screen.queryByTestId('assistant-message')).not.toBeInTheDocument()
    })

    it('should render only assistant messages', () => {
      const assistantMessage = createMockMessage('assistant', 'Response')
      const mockChatInstance = createMockChatInstance([assistantMessage])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [assistantMessage],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(screen.getByTestId('assistant-message')).toBeInTheDocument()
      expect(screen.queryByTestId('user-message')).not.toBeInTheDocument()
    })

    it('should render empty messages array', () => {
      const mockChatInstance = createMockChatInstance([])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(screen.queryByTestId('user-message')).not.toBeInTheDocument()
      expect(screen.queryByTestId('assistant-message')).not.toBeInTheDocument()
    })
  })

  describe('Encryption message', () => {
    it('should render encryption message when thread is encrypted', () => {
      const mockChatInstance = createMockChatInstance([])
      const encryptedThread: ChatThread = {
        id: 'thread-1',
        isEncrypted: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        contextSize: null,
        title: 'Encrypted Chat',
        triggeredBy: null,
        wasTriggeredByAutomation: 0,
      } as ChatThread

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: encryptedThread,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(screen.getByTestId('encryption-message')).toBeInTheDocument()
      expect(mockEncryptionMessage).toHaveBeenCalled()
    })

    it('should not render encryption message when thread is not encrypted', () => {
      const mockChatInstance = createMockChatInstance([])
      const unencryptedThread: ChatThread = {
        id: 'thread-1',
        isEncrypted: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        contextSize: null,
        title: 'Regular Chat',
        triggeredBy: null,
        wasTriggeredByAutomation: 0,
      } as ChatThread

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: unencryptedThread,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(screen.queryByTestId('encryption-message')).not.toBeInTheDocument()
    })

    it('should not render encryption message when thread is null', () => {
      const mockChatInstance = createMockChatInstance([])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(screen.queryByTestId('encryption-message')).not.toBeInTheDocument()
    })
  })

  describe('Trigger message (automation)', () => {
    it('should render trigger message when triggered by automation', () => {
      const userMessage = createMockMessage('user', 'Automation prompt')
      const mockChatInstance = createMockChatInstance([userMessage])
      const triggerData: AutomationRun = {
        prompt: {
          id: 'prompt-1',
          title: 'Test Automation',
          content: 'Automation prompt',
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
        wasTriggeredByAutomation: true,
        isAutomationDeleted: false,
      }

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(screen.getByTestId('trigger-message')).toBeInTheDocument()
      expect(mockTriggerMessage).toHaveBeenCalledWith({
        chatThreadId: 'thread-1',
        title: 'Test Automation',
        prompt: 'Automation prompt',
        isDeleted: false,
      })
    })

    it('should skip first message when triggered by automation', () => {
      const userMessage = createMockMessage('user', 'Automation prompt')
      const assistantMessage = createMockMessage('assistant', 'Response')
      const mockChatInstance = createMockChatInstance([userMessage, assistantMessage])
      const triggerData: AutomationRun = {
        prompt: null,
        wasTriggeredByAutomation: true,
        isAutomationDeleted: false,
      }

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage, assistantMessage],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      // First user message should be skipped
      const userMessages = screen.queryAllByTestId('user-message')
      expect(userMessages).toHaveLength(0)
      // Assistant message should still be rendered
      expect(screen.getByTestId('assistant-message')).toBeInTheDocument()
    })

    it('should extract prompt content from first message for trigger display', () => {
      const userMessage = createMockMessage('user', 'Extracted prompt text')
      const mockChatInstance = createMockChatInstance([userMessage])
      const triggerData: AutomationRun = {
        prompt: {
          id: 'prompt-1',
          title: 'Test Automation',
          content: 'Different content',
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
        wasTriggeredByAutomation: true,
        isAutomationDeleted: false,
      }

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(mockTriggerMessage).toHaveBeenCalledWith({
        chatThreadId: 'thread-1',
        title: 'Test Automation',
        prompt: 'Extracted prompt text',
        isDeleted: false,
      })
    })

    it('should handle trigger message with deleted automation', () => {
      const userMessage = createMockMessage('user', 'Automation prompt')
      const mockChatInstance = createMockChatInstance([userMessage])
      const triggerData: AutomationRun = {
        prompt: {
          id: 'prompt-1',
          title: 'Deleted Automation',
          content: 'Automation prompt',
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
        wasTriggeredByAutomation: true,
        isAutomationDeleted: true,
      }

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(mockTriggerMessage).toHaveBeenCalledWith({
        chatThreadId: 'thread-1',
        title: 'Deleted Automation',
        prompt: 'Automation prompt',
        isDeleted: true,
      })
    })

    it('should handle trigger message without prompt content', () => {
      const userMessage = createMockMessage('user', 'Message without text part')
      // Remove text part
      userMessage.parts = []
      const mockChatInstance = createMockChatInstance([userMessage])
      const triggerData: AutomationRun = {
        prompt: {
          id: 'prompt-1',
          title: 'Test Automation',
          content: 'Automation prompt',
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
        wasTriggeredByAutomation: true,
        isAutomationDeleted: false,
      }

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(mockTriggerMessage).toHaveBeenCalledWith({
        chatThreadId: 'thread-1',
        title: 'Test Automation',
        prompt: undefined,
        isDeleted: false,
      })
    })

    it('should not render trigger message when not triggered by automation', () => {
      const userMessage = createMockMessage('user', 'Regular message')
      const mockChatInstance = createMockChatInstance([userMessage])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(screen.queryByTestId('trigger-message')).not.toBeInTheDocument()
      expect(screen.getByTestId('user-message')).toBeInTheDocument()
    })
  })

  describe('Streaming state', () => {
    it('should pass isStreaming=true to last assistant message when streaming', () => {
      const userMessage = createMockMessage('user', 'Hello')
      const assistantMessage = createMockMessage('assistant', 'Response')
      const mockChatInstance = createMockChatInstance([userMessage, assistantMessage])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage, assistantMessage],
        status: 'streaming',
        error: null,
      })

      render(<ChatMessages />)

      expect(mockAssistantMessage).toHaveBeenCalledWith({
        message: assistantMessage,
        isStreaming: true,
      })
    })

    it('should pass isStreaming=false to assistant messages when not streaming', () => {
      const assistantMessage1 = createMockMessage('assistant', 'First response')
      const assistantMessage2 = createMockMessage('assistant', 'Second response')
      const mockChatInstance = createMockChatInstance([assistantMessage1, assistantMessage2])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [assistantMessage1, assistantMessage2],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(mockAssistantMessage).toHaveBeenCalledTimes(2)
      expect(mockAssistantMessage).toHaveBeenNthCalledWith(1, {
        message: assistantMessage1,
        isStreaming: false,
      })
      expect(mockAssistantMessage).toHaveBeenNthCalledWith(2, {
        message: assistantMessage2,
        isStreaming: false,
      })
    })

    it('should pass isStreaming=false to non-last assistant messages when streaming', () => {
      const assistantMessage1 = createMockMessage('assistant', 'First response')
      const assistantMessage2 = createMockMessage('assistant', 'Second response')
      const mockChatInstance = createMockChatInstance([assistantMessage1, assistantMessage2])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [assistantMessage1, assistantMessage2],
        status: 'streaming',
        error: null,
      })

      render(<ChatMessages />)

      expect(mockAssistantMessage).toHaveBeenNthCalledWith(1, {
        message: assistantMessage1,
        isStreaming: false,
      })
      expect(mockAssistantMessage).toHaveBeenNthCalledWith(2, {
        message: assistantMessage2,
        isStreaming: true,
      })
    })
  })

  describe('Error message', () => {
    it('should render error message when error exists', () => {
      const mockChatInstance = createMockChatInstance([])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [],
        status: 'ready',
        error: { message: 'Something went wrong' },
      })

      render(<ChatMessages />)

      expect(screen.getByTestId('error-message')).toBeInTheDocument()
      expect(mockErrorMessage).toHaveBeenCalledWith({ message: 'Something went wrong' })
    })

    it('should not render error message when no error', () => {
      const mockChatInstance = createMockChatInstance([])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(screen.queryByTestId('error-message')).not.toBeInTheDocument()
    })
  })

  describe('Complex scenarios', () => {
    it('should render all components together: encryption, trigger, messages, and error', () => {
      const userMessage = createMockMessage('user', 'Automation prompt')
      const assistantMessage = createMockMessage('assistant', 'Response')
      const mockChatInstance = createMockChatInstance([userMessage, assistantMessage])
      const encryptedThread: ChatThread = {
        id: 'thread-1',
        isEncrypted: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        contextSize: null,
        title: 'Encrypted Chat',
        triggeredBy: null,
        wasTriggeredByAutomation: 0,
      } as ChatThread
      const triggerData: AutomationRun = {
        prompt: {
          id: 'prompt-1',
          title: 'Test Automation',
          content: 'Automation prompt',
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
        wasTriggeredByAutomation: true,
        isAutomationDeleted: false,
      }

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: encryptedThread,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage, assistantMessage],
        status: 'streaming',
        error: { message: 'Stream error' },
      })

      render(<ChatMessages />)

      expect(screen.getByTestId('encryption-message')).toBeInTheDocument()
      expect(screen.getByTestId('trigger-message')).toBeInTheDocument()
      expect(screen.getByTestId('assistant-message')).toBeInTheDocument()
      expect(screen.getByTestId('error-message')).toBeInTheDocument()
      // First user message should be skipped
      expect(screen.queryByTestId('user-message')).not.toBeInTheDocument()
    })

    it('should handle messages with non-text parts', () => {
      const userMessage = createMockMessage('user', 'Hello')
      // Add a non-text part
      userMessage.parts.push({ type: 'tool-call', toolCallId: 'call-1', toolName: 'test' } as any)
      const mockChatInstance = createMockChatInstance([userMessage])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      // Should still render the user message
      expect(screen.getByTestId('user-message')).toBeInTheDocument()
    })

    it('should handle trigger message without title', () => {
      const userMessage = createMockMessage('user', 'Automation prompt')
      const mockChatInstance = createMockChatInstance([userMessage])
      const triggerData: AutomationRun = {
        prompt: null,
        wasTriggeredByAutomation: true,
        isAutomationDeleted: false,
      }

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
        status: 'ready',
        error: null,
      })

      render(<ChatMessages />)

      expect(mockTriggerMessage).toHaveBeenCalledWith({
        chatThreadId: 'thread-1',
        title: undefined,
        prompt: 'Automation prompt',
        isDeleted: false,
      })
    })
  })
})
