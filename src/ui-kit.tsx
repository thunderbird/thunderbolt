import { ArrowLeft, Paperclip } from 'lucide-react'
import { Link } from 'react-router'
import { Sidebar } from './components/sidebar'
import { Button } from './components/ui/button'
import { MailCard } from './components/ui/mail-card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'

export default function UiKitPage() {
  const fruitOptions = [
    { value: 'apple', label: 'Apple' },
    { value: 'banana', label: 'Banana' },
    { value: 'orange', label: 'Orange' },
    { value: 'grape', label: 'Grape' },
    { value: 'mango', label: 'Mango' },
  ]
  return (
    <>
      <Sidebar>
        <div className="flex flex-col gap-4">
          <Button asChild variant="outline">
            <Link to="/">
              <ArrowLeft className="size-4" />
              Home
            </Link>
          </Button>
          <div className="flex flex-col gap-2">
            <Button asChild variant="ghost" className="justify-start">
              <Link to="/settings/accounts">Accounts</Link>
            </Button>
            <Button asChild variant="ghost" className="justify-start">
              <Link to="/settings/models">Models</Link>
            </Button>
          </div>
        </div>
      </Sidebar>
      <div className="flex flex-col gap-4 p-4 w-full">
        <h2 className="text-2xl font-bold mb-4">Select</h2>
        <Select>
          <SelectTrigger>
            <SelectValue placeholder="Select a fruit" />
          </SelectTrigger>
          <SelectContent>
            {fruitOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select>
          <SelectTrigger className="border-dashed">
            <SelectValue placeholder="Select a fruit" />
          </SelectTrigger>
          <SelectContent>
            {fruitOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="h-px bg-gray-200 dark:bg-gray-700 my-10" />
        <h2 className="text-2xl font-bold mb-4">Button</h2>
        <Button variant="outline">Outline Button</Button>
        <Button variant="file">
          <Paperclip className="size-5 " />
          example.pdf
        </Button>
        <Button>Default Button</Button>
        <div className="h-px bg-gray-200 dark:bg-gray-700 my-10" />
        <h2 className="text-2xl font-bold">Mail Card</h2>
        <MailCard
          from="example@example.com"
          to="example@example.com"
          content="Mail Card Content"
          date="9/12/2024"
          footer={
            <>
              <Button variant="file">
                <Paperclip className="size-5" />
                example.pdf
              </Button>
            </>
          }
        />
      </div>
    </>
  )
}
