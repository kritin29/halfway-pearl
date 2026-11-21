import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button, Input, Label } from '@/components/ui'

/** Organizer-only invite link with a copy button. */
export function InviteLink({ inviteCode }: { inviteCode: string }) {
  const url = `${window.location.origin}/join/${inviteCode}`
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setState('copied')
      setTimeout(() => setState('idle'), 2000)
    } catch {
      // Clipboard can be blocked (permissions, insecure origin): let them copy by hand.
      setState('failed')
    }
  }

  return (
    <section aria-labelledby="invite-heading" className="rounded-lg border border-border bg-card p-4 sm:p-5">
      <h2 id="invite-heading" className="text-base font-semibold">
        Invite friends
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">Anyone with this link can join (up to 8 travelers).</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Label htmlFor="invite-link" className="sr-only">
          Invite link
        </Label>
        <Input
          id="invite-link"
          data-testid="invite-link"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs sm:text-sm"
        />
        <Button type="button" variant="outline" onClick={() => void copy()} className="shrink-0">
          {state === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}
          {state === 'copied' ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      {state === 'failed' && (
        <p role="alert" className="mt-2 text-sm text-muted-foreground">
          Couldn’t copy automatically. Select the link and copy it yourself.
        </p>
      )}
    </section>
  )
}
