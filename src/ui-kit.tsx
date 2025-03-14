import { ArrowLeft, PanelLeft, PanelRight, Paperclip, SquarePen } from 'lucide-react'
import { Link } from 'react-router'
import { Sidebar } from './components/sidebar'
import { Button } from './components/ui/button'
import { ChatNavButton } from './components/ui/chat-nav-button'
import { MailCard, MailCardList } from './components/ui/mail-card'
import { MailThreadButton } from './components/ui/mail-thread-button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import { UserNavButton } from './components/ui/user-nav-button'

export default function UiKitPage() {
  const fruitOptions = [
    { value: 'apple', label: 'Apple' },
    { value: 'banana', label: 'Banana' },
    { value: 'orange', label: 'Orange' },
    { value: 'grape', label: 'Grape' },
    { value: 'mango', label: 'Mango' },
  ]

  const fakeEmails = [
    {
      id: 'mail-1',
      from: 'john.doe@company.com',
      to: 'me@example.com',
      date: '2:34 PM',
      content:
        "Hi there,\n\nI hope this email finds you well. I wanted to follow up on the project timeline we discussed in yesterday's meeting. Could you please confirm if the proposed deadlines work for your team?\n\nLooking forward to your response.\n\nBest regards,\nJohn",
      attachments: [{ filename: 'project_timeline.pdf', url: '/files/project_timeline.pdf' }],
    },
    {
      id: 'mail-2',
      from: 'marketing@newsletter.com',
      to: 'me@example.com',
      date: 'Yesterday',
      content: 'Check out our latest product offerings and exclusive deals just for you!',
      attachments: [
        { filename: 'catalog_2023.pdf', url: '/files/catalog_2023.pdf' },
        { filename: 'price_list.xlsx', url: '/files/price_list.xlsx' },
      ],
    },
    {
      id: 'mail-3',
      from: 'support@service.com',
      to: 'me@example.com',
      date: 'Jan 15',
      content: 'Your support ticket #45678 has been resolved. Please let us know if you need any further assistance.',
    },
    {
      id: 'mail-4',
      from: 'team@project.org',
      to: 'me@example.com',
      date: 'Jan 12',
      content: 'The team meeting has been rescheduled to Thursday at 2pm. Please update your calendar accordingly.',
      attachments: [{ filename: 'meeting_agenda.docx', url: '/files/meeting_agenda.docx' }],
    },
    {
      id: 'mail-5',
      from: 'notifications@platform.com',
      to: 'me@example.com',
      date: 'Jan 10',
      content: 'Your account password was recently changed. If you did not make this change, please contact support immediately.',
    },
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
            <Button asChild variant="ghost" className="justify-start font-medium text-primary">
              <Link to="/ui-kit">UI Kit</Link>
            </Button>
            <Button asChild variant="ghost" className="justify-start pl-6">
              <Link to="/devtools">Dev Tools</Link>
            </Button>
          </div>
          <ChatNavButton chatTitle="Chat Title Display" />

          <UserNavButton />
        </div>
      </Sidebar>
      <div className="flex flex-col gap-4 p-4 w-full">
        <h2 className="text-2xl font-bold mb-4">Select</h2>
        <Select>
          <SelectTrigger variant="outline" size="lg">
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
        <div className="h-px bg-gray-200 dark:bg-gray-700 my-10" />
        <h2 className="text-2xl font-bold mb-4">Button</h2>
        <Button variant="outline">Outline Button</Button>
        <Button variant="file">
          <Paperclip className="size-5" />
          example.pdf
        </Button>
        <Button variant="ghost" className="w-fit pr-1 pl-1">
          <PanelLeft className="size-5" />
        </Button>
        <Button variant="ghost" className="w-fit pr-1 pl-1">
          <PanelRight className="size-5" />
        </Button>
        <Button variant="ghost" className="w-fit pr-1 pl-1">
          <SquarePen className="size-5" />
        </Button>
        <Button>Default Button</Button>
        <Button variant="ghost">Ghost Button</Button>
        <MailThreadButton mailTitle="Mail Title Display" />
        <div className="h-px bg-gray-200 dark:bg-gray-700 my-10" />
        <h2 className="text-2xl font-bold">Mail Card List</h2>
        <MailCardList>
          {fakeEmails.map((email) => (
            <MailCard
              key={email.id}
              id={email.id}
              from={email.from}
              to={email.to}
              date={email.date}
              content={email.content}
              footer={
                email.attachments &&
                email.attachments.length > 0 && (
                  <>
                    {email.attachments.map((attachment) => (
                      <Button key={attachment.filename} variant="file" asChild>
                        <a href={attachment.url} target="_blank" rel="noopener noreferrer">
                          <Paperclip className="size-5" />
                          {attachment.filename}
                        </a>
                      </Button>
                    ))}
                  </>
                )
              }
            />
          ))}
        </MailCardList>
      </div>
    </>
  )
}
