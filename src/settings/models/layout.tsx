/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus } from 'lucide-react'
import { Navigate, Outlet, useNavigate, useParams } from 'react-router'
import { useDatabase } from '@/contexts'
import { getAllModels } from '@/dal'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'

export default function ModelsLayout() {
  const db = useDatabase()
  const navigate = useNavigate()
  const { modelId } = useParams()

  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    query: toCompilableQuery(getAllModels(db)),
  })

  // Find the currently selected model
  const currentModel = models.find((model) => model.id === modelId)

  // Check if we're on the "new" route
  const isNewRoute = window.location.pathname.endsWith('/models/new')

  // Redirect to first model if no model is selected and we're not on the new route
  if (!modelId && models.length > 0 && !isNewRoute) {
    return <Navigate to={`/settings/models/${models[0].id}`} replace />
  }

  const handleModelSelect = (value: string) => {
    navigate(`/settings/models/${value}`)
  }

  return (
    <div className="flex flex-col gap-6 p-4 w-full max-w-[760px] mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="mt-8 text-4xl font-bold tracking-tight mb-2 text-primary">Models</h1>
        <Button variant="outline" size="icon" onClick={() => navigate('/settings/models/new')}>
          <Plus />
        </Button>
      </div>

      <Select value={modelId || ''} onValueChange={handleModelSelect}>
        <SelectTrigger className="w-full p-6 py-8">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center bg-primary text-primary-foreground size-8 rounded-md font-medium">
              {currentModel?.provider?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="flex flex-col">
              <SelectValue placeholder="Select a model" />
            </div>
          </div>
        </SelectTrigger>
        <SelectContent>
          {models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              <p className="text-left">
                {model.provider === 'thunderbolt' && 'Thunderbolt'}
                {model.provider === 'openai' && 'OpenAI'}
                {model.provider === 'openrouter' && 'OpenRouter'}
                {model.provider === 'custom' && 'Custom'} - {model.model}
              </p>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Outlet context={{ selectedModel: modelId, currentModel }} />
    </div>
  )
}
