type StepIndicatorsProps = {
  currentStep: number
  totalSteps: number
}

export const StepIndicators = ({ currentStep, totalSteps }: StepIndicatorsProps) => {
  return (
    <div className="flex justify-center gap-2">
      {Array.from({ length: totalSteps }, (_, index) => (
        <div key={index} className={`h-2 w-2 rounded-full ${currentStep >= index + 1 ? 'bg-primary' : 'bg-muted'}`} />
      ))}
    </div>
  )
}
