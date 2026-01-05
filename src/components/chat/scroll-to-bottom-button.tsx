import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown } from 'lucide-react'

type ScrollToBottomButtonProps = {
  isVisible: boolean
  onClick: () => void
  className?: string
}

export const ScrollToBottomButton = ({ isVisible, onClick, className }: ScrollToBottomButtonProps) => (
  <AnimatePresence>
    {isVisible && (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        transition={{ duration: 0.2 }}
        className={cn('absolute bottom-0 left-1/2 -translate-x-1/2 z-10', className)}
      >
        <Button
          variant="outline"
          size="icon"
          className="rounded-full bg-background/80 backdrop-blur-sm shadow-md size-8"
          onClick={onClick}
          aria-label="Scroll to bottom"
        >
          <ChevronDown className="size-4" />
        </Button>
      </motion.div>
    )}
  </AnimatePresence>
)
