/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { render } from '@testing-library/react'
import { describe, it, expect } from 'bun:test'
import '@testing-library/jest-dom'
import { StepIndicators } from './step-indicators'

describe('StepIndicators', () => {
  describe('Component rendering', () => {
    it('should render correct number of step indicators', () => {
      render(<StepIndicators currentStep={1} totalSteps={5} />)

      const indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators).toHaveLength(5)
    })

    it('should render single step indicator', () => {
      render(<StepIndicators currentStep={1} totalSteps={1} />)

      const indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators).toHaveLength(1)
    })

    it('should render multiple step indicators', () => {
      render(<StepIndicators currentStep={3} totalSteps={7} />)

      const indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators).toHaveLength(7)
    })
  })

  describe('Step highlighting', () => {
    it('should highlight first step when currentStep is 1', () => {
      render(<StepIndicators currentStep={1} totalSteps={5} />)

      const indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators[0]).toHaveClass('bg-primary')
      expect(indicators[1]).toHaveClass('bg-muted')
      expect(indicators[2]).toHaveClass('bg-muted')
      expect(indicators[3]).toHaveClass('bg-muted')
      expect(indicators[4]).toHaveClass('bg-muted')
    })

    it('should highlight first two steps when currentStep is 2', () => {
      render(<StepIndicators currentStep={2} totalSteps={5} />)

      const indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators[0]).toHaveClass('bg-primary')
      expect(indicators[1]).toHaveClass('bg-primary')
      expect(indicators[2]).toHaveClass('bg-muted')
      expect(indicators[3]).toHaveClass('bg-muted')
      expect(indicators[4]).toHaveClass('bg-muted')
    })

    it('should highlight all steps when currentStep equals totalSteps', () => {
      render(<StepIndicators currentStep={5} totalSteps={5} />)

      const indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      indicators.forEach((indicator) => {
        expect(indicator).toHaveClass('bg-primary')
      })
    })

    it('should highlight all steps when currentStep exceeds totalSteps', () => {
      render(<StepIndicators currentStep={6} totalSteps={5} />)

      const indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      indicators.forEach((indicator) => {
        expect(indicator).toHaveClass('bg-primary')
      })
    })

    it('should not highlight any steps when currentStep is 0', () => {
      render(<StepIndicators currentStep={0} totalSteps={5} />)

      const indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      indicators.forEach((indicator) => {
        expect(indicator).toHaveClass('bg-muted')
      })
    })
  })

  describe('Visual structure', () => {
    it('should have proper container structure', () => {
      render(<StepIndicators currentStep={2} totalSteps={4} />)

      const container = document.querySelector('.flex.justify-center.gap-2')
      expect(container).toBeInTheDocument()
    })

    it('should have proper indicator styling', () => {
      render(<StepIndicators currentStep={1} totalSteps={3} />)

      const indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      indicators.forEach((indicator) => {
        expect(indicator).toHaveClass('h-2')
        expect(indicator).toHaveClass('w-2')
        expect(indicator).toHaveClass('rounded-full')
      })
    })
  })

  describe('Edge cases', () => {
    it('should handle zero totalSteps', () => {
      render(<StepIndicators currentStep={1} totalSteps={0} />)

      const indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators).toHaveLength(0)
    })

    it('should handle negative currentStep', () => {
      render(<StepIndicators currentStep={-1} totalSteps={3} />)

      const indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators).toHaveLength(3)
      indicators.forEach((indicator) => {
        expect(indicator).toHaveClass('bg-muted')
      })
    })

    it('should handle large totalSteps', () => {
      render(<StepIndicators currentStep={5} totalSteps={20} />)

      const indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators).toHaveLength(20)

      // First 5 should be highlighted
      for (let i = 0; i < 5; i++) {
        expect(indicators[i]).toHaveClass('bg-primary')
      }

      // Rest should be muted
      for (let i = 5; i < 20; i++) {
        expect(indicators[i]).toHaveClass('bg-muted')
      }
    })
  })

  describe('Step progression', () => {
    it('should show progression through all steps', () => {
      const { rerender } = render(<StepIndicators currentStep={1} totalSteps={4} />)

      // Step 1
      let indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators[0]).toHaveClass('bg-primary')
      expect(indicators[1]).toHaveClass('bg-muted')
      expect(indicators[2]).toHaveClass('bg-muted')
      expect(indicators[3]).toHaveClass('bg-muted')

      // Step 2
      rerender(<StepIndicators currentStep={2} totalSteps={4} />)
      indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators[0]).toHaveClass('bg-primary')
      expect(indicators[1]).toHaveClass('bg-primary')
      expect(indicators[2]).toHaveClass('bg-muted')
      expect(indicators[3]).toHaveClass('bg-muted')

      // Step 3
      rerender(<StepIndicators currentStep={3} totalSteps={4} />)
      indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators[0]).toHaveClass('bg-primary')
      expect(indicators[1]).toHaveClass('bg-primary')
      expect(indicators[2]).toHaveClass('bg-primary')
      expect(indicators[3]).toHaveClass('bg-muted')

      // Step 4 (final)
      rerender(<StepIndicators currentStep={4} totalSteps={4} />)
      indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators[0]).toHaveClass('bg-primary')
      expect(indicators[1]).toHaveClass('bg-primary')
      expect(indicators[2]).toHaveClass('bg-primary')
      expect(indicators[3]).toHaveClass('bg-primary')
    })
  })

  describe('Accessibility', () => {
    it('should render without accessibility issues', () => {
      render(<StepIndicators currentStep={2} totalSteps={5} />)

      const container = document.querySelector('.flex.justify-center.gap-2')
      expect(container).toBeInTheDocument()
    })

    it('should maintain consistent structure across re-renders', () => {
      const { rerender } = render(<StepIndicators currentStep={1} totalSteps={3} />)

      let indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators).toHaveLength(3)

      rerender(<StepIndicators currentStep={2} totalSteps={3} />)
      indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators).toHaveLength(3)

      rerender(<StepIndicators currentStep={3} totalSteps={3} />)
      indicators = document.querySelectorAll('.h-2.w-2.rounded-full')
      expect(indicators).toHaveLength(3)
    })
  })
})
