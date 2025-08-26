# Token Limit Validation

This document describes the token limit validation feature implemented to prevent errors when submitting messages that exceed the model's token limit.

## Overview

The token validation feature provides real-time validation of message length before submission, ensuring that conversations don't exceed the model's context window. This prevents API errors and provides users with clear feedback about token usage.

## Features

- **Real-time validation**: Token counting happens as users type (debounced by 500ms)
- **Multi-model support**: Supports OpenAI, Anthropic, Mistral, and Qwen models
- **Accurate token counting**: Uses official tokenizers for each model type
- **User-friendly error messages**: Clear feedback with suggestions for resolution
- **Visual indicators**: Progress bars and detailed token usage information

## Supported Models

### OpenAI Models
- GPT-4o (128K tokens)
- GPT-4o-mini (128K tokens)
- GPT-4-turbo (128K tokens)
- GPT-4 (8K tokens)
- GPT-3.5-turbo (4K tokens)
- GPT-3.5-turbo-16k (16K tokens)

### Anthropic Models
- Claude 3.5 Sonnet (200K tokens)
- Claude 3.5 Haiku (200K tokens)
- Claude 3 Opus (200K tokens)
- Claude 3 Sonnet (200K tokens)
- Claude 3 Haiku (200K tokens)
- Claude 2.1 (200K tokens)
- Claude 2.0 (100K tokens)
- Claude Instant 1.2 (100K tokens)

### Mistral Models
- Mistral Large (32K tokens)
- Mistral Medium (32K tokens)
- Mistral Small (32K tokens)
- Nemo (32K tokens)

### Qwen Models
- All Qwen 2.5 variants (32K tokens)

## Implementation Details

### Token Counting

The system uses two tokenizer libraries:

1. **js-tiktoken**: For OpenAI and Anthropic models
2. **@xenova/transformers**: For open-source models (Qwen, Mistral, etc.)

### Validation Flow

1. User types a message
2. After 500ms of inactivity, token validation begins
3. System counts tokens in:
   - System prompt
   - Existing conversation history
   - New message
4. If total tokens exceed the model's limit, submission is blocked
5. User sees detailed error message with suggestions

### Error Handling

- Graceful fallback to character-based estimation if tokenizer fails
- Validation errors don't block message submission (fails open)
- Clear error messages with actionable suggestions

## User Experience

### Error Message Example

```
Message Too Long

The conversation (including tool call data) has used 9,500 tokens, which exceeds the maximum of 8,192 tokens (116% of limit). Consider starting a new conversation or shortening your message.

Current conversation: 8,200 tokens
New message: 1,300 tokens
Total: 9,500 / 8,192 tokens (116%)

Suggestions:
• Start a new conversation to reset the context
• Shorten your message by removing unnecessary details
• Break your request into smaller, focused questions
```

### Visual Indicators

- Progress bar showing token usage percentage
- Submit button disabled when limit would be exceeded
- Real-time token count updates
- Dismissible error messages

## Technical Architecture

### Files

- `src/lib/token-utils.ts`: Core token counting logic
- `src/hooks/use-token-validation.ts`: React hook for validation state
- `src/components/chat/token-validation-error.tsx`: Error display component
- `src/components/chat/chat-ui.tsx`: Integration with chat interface

### Key Functions

- `countTokens()`: Count tokens in text for a specific model
- `countChatTokens()`: Count tokens in conversation including system prompt
- `wouldExceedTokenLimit()`: Check if message would exceed limit
- `getModelContextWindow()`: Get context window size for model

## Future Enhancements

- Message summarization for long conversations
- Automatic context truncation
- Token usage analytics
- Custom token limits per model
- Support for additional model providers