// ⚠ Future Backlog — not wired into Settings (BA decision 2026-08-06, C6).
// Phase 4 ships fixed in-app notifications (Work Item assignment, Note mentions)
// only; user-configurable Notification Preferences are out of scope. This
// component is retained unchanged for when the feature is re-scheduled. It is
// deliberately not imported by settings-page.tsx.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsTabHeader } from './settings-tab-header'
import { Loader2, RotateCcw } from 'lucide-react'

import { Button } from '@/shared/ui/button'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { Card, CardHeader, CardBody } from '@/shared/ui/card'
import { Switch } from '@/shared/ui/switch'
import { notify } from '@/shared/lib/toast'
import {
  useNotificationPreferences,
  useUpsertNotificationPreference,
  useResetNotificationPreference,
} from '@/features/notifications/api'

// Mirror of NOTIFICATION_TEMPLATE_NAMES (@platform/notifications) — the backend
// validates the `:type` path param against the same list.
const TYPES = [
  'WORKSPACE_INVITATION',
  'WORKSPACE_INVITATION_ACCEPTED',
  'WORK_ITEM_ASSIGNED',
  'WORK_ITEM_STATE_CHANGED',
  'WORK_ITEM_COMMENTED',
  'WORK_ITEM_MENTIONED',
] as const

// Mirror of EMAIL_CHANNEL_BY_TEMPLATE (@platform/notifications). A type absent here is
// in-app only — the relay refuses the email channel for it whatever the preference says, so
// the toggle is shown off and disabled rather than offering a switch that does nothing.
const EMAIL_CAPABLE: ReadonlySet<string> = new Set([
  '*',
  'WORKSPACE_INVITATION',
  'WORKSPACE_INVITATION_ACCEPTED',
  'WORK_ITEM_STATE_CHANGED',
  'WORK_ITEM_COMMENTED',
  'WORK_ITEM_MENTIONED',
])

type Channel = 'inApp' | 'email'

const GRID = 'grid grid-cols-[1fr_72px_72px] items-center gap-x-2'

export function NotificationsTab() {
  const { t } = useTranslation('settings')
  const { data: prefs = [], isLoading } = useNotificationPreferences()
  const upsert = useUpsertNotificationPreference()
  const reset = useResetNotificationPreference()
  // Open state for the reset-all confirmation dialog.
  const [confirmReset, setConfirmReset] = useState(false)

  const byType = new Map(prefs.map((p) => [p.type, p]))

  // Resolution mirrors the backend: a specific-type row wins, else the '*'
  // wildcard, else the default (both channels on).
  function resolve(type: string, channel: Channel): boolean {
    const specific = byType.get(type)
    if (specific) return specific[channel]
    const wildcard = byType.get('*')
    if (wildcard) return wildcard[channel]
    return true
  }

  // Always write the full resolved state so flipping one channel can't clobber
  // the other into a stale value.
  function toggle(type: string, channel: Channel) {
    upsert.mutate(
      {
        type,
        inApp: channel === 'inApp' ? !resolve(type, 'inApp') : resolve(type, 'inApp'),
        email: channel === 'email' ? !resolve(type, 'email') : resolve(type, 'email'),
      },
      { onError: (e) => notify.fromError(e, t('notifications.saveFailed')) },
    )
  }

  async function resetAll() {
    try {
      await Promise.all(prefs.map((p) => reset.mutateAsync(p.type)))
      notify.success(t('notifications.resetDone'))
    } catch (e) {
      notify.fromError(e, t('notifications.saveFailed'))
    }
  }

  const busy = upsert.isPending || reset.isPending

  return (
    <>
      <SettingsTabHeader
        contained
        title={t('nav.notifications')}
        description={t('tabDescriptions.notifications')}
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          <Card>
            <CardHeader
              title={t('notifications.sectionTitle')}
              actions={
                prefs.length > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmReset(true)}
                    title={t('notifications.resetHint')}
                  >
                    {reset.isPending ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <RotateCcw size={13} />
                    )}
                    {t('notifications.resetAll')}
                  </Button>
                ) : undefined
              }
            />
            <CardBody className="p-0">
              {/* Column header */}
              <div
                className={`${GRID} border-b border-border-subtle bg-surface-hover px-4 py-2 text-ui-xs font-semibold tracking-wide text-foreground-subtle uppercase`}
              >
                <span>{t('notifications.colType')}</span>
                <span className="text-center">{t('notifications.colInApp')}</span>
                <span className="text-center">{t('notifications.colEmail')}</span>
              </div>

              {isLoading ? (
                <div className="flex items-center justify-center gap-2 px-4 py-8 text-ui-sm text-foreground-subtle">
                  <Loader2 size={14} className="animate-spin" />
                </div>
              ) : (
                <>
                  {/* Master switch — sits above the per-type rows and applies to all
                  types unless a specific type below overrides it. */}
                  <PrefRow
                    label={t('notifications.masterName')}
                    desc={t('notifications.masterHint')}
                    inApp={resolve('*', 'inApp')}
                    email={resolve('*', 'email')}
                    disabled={busy}
                    onToggle={(ch) => toggle('*', ch)}
                    emphasis
                    colInApp={t('notifications.colInApp')}
                    colEmail={t('notifications.colEmail')}
                  />
                  {TYPES.map((type) => (
                    <PrefRow
                      key={type}
                      label={t(`notifications.types.${type}.label`)}
                      desc={t(`notifications.types.${type}.desc`)}
                      inApp={resolve(type, 'inApp')}
                      email={EMAIL_CAPABLE.has(type) && resolve(type, 'email')}
                      emailDisabled={!EMAIL_CAPABLE.has(type)}
                      disabled={busy}
                      onToggle={(ch) => toggle(type, ch)}
                      colInApp={t('notifications.colInApp')}
                      colEmail={t('notifications.colEmail')}
                    />
                  ))}
                </>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        title={t('notifications.resetTitle', 'Reset preferences')}
        message={t(
          'notifications.resetConfirm',
          'Reset all notification preferences to their defaults?',
        )}
        confirmLabel={t('notifications.resetAll')}
        pending={reset.isPending}
        onConfirm={() => {
          setConfirmReset(false)
          void resetAll()
        }}
        onCancel={() => setConfirmReset(false)}
      />
    </>
  )
}

// ── One matrix row: label + In-app / Email checkboxes ────────────────────────

function PrefRow({
  label,
  desc,
  inApp,
  email,
  disabled,
  emailDisabled = false,
  onToggle,
  emphasis = false,
  colInApp,
  colEmail,
}: {
  label: string
  desc: string
  inApp: boolean
  email: boolean
  disabled: boolean
  /** This template is in-app only — the email channel is not a choice for it. */
  emailDisabled?: boolean
  onToggle: (channel: Channel) => void
  emphasis?: boolean
  colInApp: string
  colEmail: string
}) {
  return (
    <div
      className={`${GRID} border-b border-border-subtle px-4 py-3 last:border-0 ${
        emphasis ? 'bg-surface-subtle' : ''
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-ui-md font-medium text-foreground">{label}</p>
        <p className="text-ui-sm text-foreground-subtle">{desc}</p>
      </div>
      <div className="flex justify-center">
        <Switch
          checked={inApp}
          onChange={() => onToggle('inApp')}
          ariaLabel={`${label} — ${colInApp}`}
          disabled={disabled}
        />
      </div>
      <div className="flex justify-center">
        <Switch
          checked={email}
          onChange={() => onToggle('email')}
          ariaLabel={`${label} — ${colEmail}`}
          disabled={disabled || emailDisabled}
        />
      </div>
    </div>
  )
}
