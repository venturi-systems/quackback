import { useState, useTransition } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { ChatBubbleLeftRightIcon, ArrowPathIcon } from '@heroicons/react/24/solid'
import { settingsQueries } from '@/lib/client/queries/settings'
import { updateWidgetConfigFn } from '@/lib/server/functions/settings'
import { BackLink } from '@/components/ui/back-link'
import { PageHeader } from '@/components/shared/page-header'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'

export const Route = createFileRoute('/admin/settings/live-chat')({
  loader: async ({ context }) => {
    const { requireWorkspaceRole } = await import('@/lib/server/functions/workspace-utils')
    await requireWorkspaceRole({ data: { allowedRoles: ['admin'] } })
    await context.queryClient.ensureQueryData(settingsQueries.widgetConfig())
    return {}
  },
  component: LiveChatSettingsPage,
})

function LiveChatSettingsPage() {
  const router = useRouter()
  const widgetConfigQuery = useSuspenseQuery(settingsQueries.widgetConfig())
  const config = widgetConfigQuery.data
  const [isPending, startTransition] = useTransition()
  const [savingField, setSavingField] = useState<string | null>(null)

  const [enabled, setEnabled] = useState(config.chat?.enabled ?? false)
  const [welcomeMessage, setWelcomeMessage] = useState(config.chat?.welcomeMessage ?? '')
  const [offlineMessage, setOfflineMessage] = useState(config.chat?.offlineMessage ?? '')
  const [teamName, setTeamName] = useState(config.chat?.teamName ?? '')

  const widgetEnabled = config.enabled

  async function persist(
    field: string,
    data: Parameters<typeof updateWidgetConfigFn>[0]['data'],
    revert?: () => void
  ) {
    setSavingField(field)
    try {
      await updateWidgetConfigFn({ data })
      startTransition(() => router.invalidate())
    } catch {
      revert?.()
    } finally {
      setSavingField(null)
    }
  }

  const onToggleEnabled = (checked: boolean) => {
    setEnabled(checked)
    // Enabling chat also surfaces the widget tab; disabling hides it.
    persist('enabled', { chat: { enabled: checked }, tabs: { chat: checked } }, () =>
      setEnabled(!checked)
    )
  }

  const isBusy = savingField !== null || isPending

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="lg:hidden">
        <BackLink to="/admin/settings">Settings</BackLink>
      </div>
      <PageHeader
        icon={ChatBubbleLeftRightIcon}
        title="Live Chat"
        description="Let visitors message your team in real time from the widget."
      />

      {!widgetEnabled && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          The widget is currently disabled. Enable it under{' '}
          <span className="font-medium">Widget</span> settings for live chat to appear.
        </div>
      )}

      <SettingsCard
        title="Live chat"
        description="Show a chat tab in the widget so visitors can start a conversation with your team."
      >
        <div className="flex items-center justify-between py-1">
          <div className="pr-4">
            <Label htmlFor="chat-enabled" className="text-sm font-medium cursor-pointer">
              Enable live chat
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Adds a Chat tab to the widget and an inbox in the admin panel.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {savingField === 'enabled' && (
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
            <Switch
              id="chat-enabled"
              checked={enabled}
              onCheckedChange={onToggleEnabled}
              disabled={isBusy}
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Messaging"
        description="Customize the greeting and team name shown to visitors."
      >
        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="chat-team-name">Team name</Label>
            <Input
              id="chat-team-name"
              value={teamName}
              maxLength={80}
              placeholder="Support"
              onChange={(e) => setTeamName(e.target.value)}
              onBlur={() => persist('teamName', { chat: { teamName: teamName.trim() } })}
              disabled={isBusy || !enabled}
            />
            <p className="text-xs text-muted-foreground">
              Shown above agent replies. Defaults to your workspace name.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="chat-welcome">Welcome message</Label>
            <Textarea
              id="chat-welcome"
              value={welcomeMessage}
              maxLength={500}
              rows={2}
              placeholder="Hi! 👋 How can we help you today?"
              onChange={(e) => setWelcomeMessage(e.target.value)}
              onBlur={() =>
                persist('welcomeMessage', { chat: { welcomeMessage: welcomeMessage.trim() } })
              }
              disabled={isBusy || !enabled}
            />
            <p className="text-xs text-muted-foreground">
              The first thing visitors see when they open chat.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="chat-offline">Offline message</Label>
            <Textarea
              id="chat-offline"
              value={offlineMessage}
              maxLength={500}
              rows={2}
              placeholder="We're away right now — leave a message and we'll get back to you by email."
              onChange={(e) => setOfflineMessage(e.target.value)}
              onBlur={() =>
                persist('offlineMessage', { chat: { offlineMessage: offlineMessage.trim() } })
              }
              disabled={isBusy || !enabled}
            />
            <p className="text-xs text-muted-foreground">
              Shown when no agents are currently available to reply.
            </p>
          </div>
        </div>
      </SettingsCard>
    </div>
  )
}
