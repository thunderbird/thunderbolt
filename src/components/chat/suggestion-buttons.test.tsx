import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { SuggestionButtons } from './suggestion-buttons'

describe('SuggestionButtons', () => {
  describe('rendering', () => {
    it('should render all suggestion buttons', () => {
      const mockOnSelectPrompt = mock()

      render(<SuggestionButtons onSelectPrompt={mockOnSelectPrompt} />)

      expect(screen.getByText('Check the weather')).toBeInTheDocument()
      expect(screen.getByText('Check your to dos')).toBeInTheDocument()
      expect(screen.getByText('Write a message')).toBeInTheDocument()
      expect(screen.getByText('Understand a topic')).toBeInTheDocument()
    })
  })

  describe('interaction', () => {
    it('should call onSelectPrompt with correct prompt when button is clicked', () => {
      const mockOnSelectPrompt = mock()

      render(<SuggestionButtons onSelectPrompt={mockOnSelectPrompt} />)

      const weatherButton = screen.getByText('Check the weather')
      fireEvent.click(weatherButton)

      expect(mockOnSelectPrompt).toHaveBeenCalledTimes(1)
      expect(mockOnSelectPrompt).toHaveBeenCalledWith('What is the forecast for this week?')
    })

    it('should call onSelectPrompt with correct prompt for each button', () => {
      const mockOnSelectPrompt = mock()

      render(<SuggestionButtons onSelectPrompt={mockOnSelectPrompt} />)

      // Click "Check your to dos" button
      fireEvent.click(screen.getByText('Check your to dos'))
      expect(mockOnSelectPrompt).toHaveBeenCalledWith('What are my current tasks?')

      // Click "Write a message" button
      fireEvent.click(screen.getByText('Write a message'))
      expect(mockOnSelectPrompt).toHaveBeenCalledWith(
        'Write a thank you email to my coworker for helping with the meeting yesterday.',
      )

      // Click "Understand a topic" button
      fireEvent.click(screen.getByText('Understand a topic'))
      expect(mockOnSelectPrompt).toHaveBeenCalledWith(
        'Explain how checks and balances work between the three branches of government.',
      )

      // Verify all buttons were clicked
      expect(mockOnSelectPrompt).toHaveBeenCalledTimes(3)
    })

    it('should call onSelectPrompt multiple times when multiple buttons are clicked', () => {
      const mockOnSelectPrompt = mock()

      render(<SuggestionButtons onSelectPrompt={mockOnSelectPrompt} />)

      fireEvent.click(screen.getByText('Check the weather'))
      fireEvent.click(screen.getByText('Check your to dos'))
      fireEvent.click(screen.getByText('Check the weather'))

      expect(mockOnSelectPrompt).toHaveBeenCalledTimes(3)
      expect(mockOnSelectPrompt).toHaveBeenNthCalledWith(1, 'What is the forecast for this week?')
      expect(mockOnSelectPrompt).toHaveBeenNthCalledWith(2, 'What are my current tasks?')
      expect(mockOnSelectPrompt).toHaveBeenNthCalledWith(3, 'What is the forecast for this week?')
    })
  })
})
