import { describe, expect, it } from 'vitest'
import {
  appUrlFor,
  buildLockEmail,
  emailSendBody,
  escapeHtml,
  isEmailAddress,
  lockEmailKey,
  oneLine,
  summarizeFare,
  type LockEmailInput,
} from './email'
import type { FareRow } from './results'

const fare: FareRow = {
  candidateIata: 'BNA',
  travelerId: 'user_bob',
  status: 'ok',
  price: 187,
  originIata: 'BOS',
  stops: 1,
  durationMin: 255,
  departLocal: '2026-12-11 07:15',
  arriveLocal: '2026-12-11 10:30',
  airline: 'Delta',
  priceLevel: 'low',
  bookingUrl: 'https://www.google.com/travel/flights?tfs=abc123',
}

function input(over: Partial<LockEmailInput> = {}): LockEmailInput {
  return {
    appUrl: 'https://halfway-pearl.app.space',
    tripId: '1763_abc',
    tripName: 'Spring break',
    outboundDate: '2026-12-11',
    returnDate: '2026-12-13',
    destination: { iata: 'BNA', city: 'Nashville', country: 'United States' },
    organizerName: 'Alice',
    recipient: { displayName: 'Bob', email: 'bob@example.test', homeAirports: ['BOS'] },
    fare,
    ...over,
  }
}

describe('buildLockEmail', () => {
  it('is branded Halfway and addressed to one person, with their own fare, origin, times and booking link', () => {
    const m = buildLockEmail(input())
    expect(m.to).toBe('bob@example.test')
    expect(m.subject).toBe('Halfway: Spring break is going to Nashville')
    for (const part of [m.text, m.html]) {
      expect(part).toContain('Halfway')
      expect(part).toContain('Hi Bob,')
      expect(part).toContain('Alice locked the destination')
      expect(part).toContain('Nashville (BNA)')
      expect(part).toContain('Dec 11 – 13, 2026')
      expect(part).toContain('$187 round trip from BOS to BNA')
      expect(part).toContain('1 stop')
      expect(part).toContain('Departs 7:15 AM, arrives 10:30 AM (Dec 11)')
      expect(part).toContain('4h 15m')
      expect(part).toContain('Delta')
      expect(part).toContain('https://www.google.com/travel/flights?tfs=abc123')
      expect(part).toContain('https://halfway-pearl.app.space/t/1763_abc')
    }
  })

  it('the email/send body has exactly to, subject, html and text: no from, reply_to, cc or bcc', () => {
    const body = emailSendBody(buildLockEmail(input()))
    expect(Object.keys(body).sort()).toEqual(['html', 'subject', 'text', 'to'])
    expect(typeof body.to).toBe('string')
  })

  it('never carries a budget: the input has no budget field, and nothing budget-like leaks in', () => {
    // Even if a caller sloppily spreads a traveler row with budget fields into the input,
    // the builder only reads the fields it declares.
    const sloppy = {
      ...input(),
      recipient: { ...input().recipient, maxUsd: 4321, budget: 4321 },
      budgets: [{ userId: 'user_alice', maxUsd: 9876 }],
    } as unknown as LockEmailInput
    const m = buildLockEmail(sloppy)
    for (const part of [m.subject, m.text, m.html]) {
      expect(part).not.toContain('4321')
      expect(part).not.toContain('4,321')
      expect(part).not.toContain('9876')
      expect(part).not.toContain('9,876')
      expect(part.toLowerCase()).not.toContain('budget')
    }
  })

  it('contains no other address than the recipient’s', () => {
    const m = buildLockEmail(input())
    const addresses = `${m.text} ${m.html}`.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []
    expect(new Set(addresses)).toEqual(new Set())
    expect(m.to).toBe('bob@example.test')
  })

  it('escapes user-written text in the HTML and keeps the subject on one line', () => {
    const m = buildLockEmail(
      input({
        tripName: '<script>alert(1)</script>\nBcc: evil@example.test',
        recipient: { displayName: 'Bob <b>&</b>', email: 'bob@example.test', homeAirports: ['BOS'] },
        organizerName: '"Al"',
      }),
    )
    expect(m.html).not.toContain('<script>')
    expect(m.html).toContain('&lt;script&gt;')
    expect(m.html).toContain('Bob &lt;b&gt;&amp;&lt;/b&gt;')
    expect(m.html).toContain('&quot;Al&quot;')
    expect(m.subject).not.toMatch(/[\r\n]/)
    expect(m.subject.startsWith('Halfway: ')).toBe(true)
  })

  it('home destination: no flight to book, no link', () => {
    const home = { ...fare, price: 0, originIata: 'BNA', stops: 0, departLocal: null, arriveLocal: null }
    const s = summarizeFare(input({ fare: home }))
    expect(s).toMatchObject({ kind: 'home', link: null })
    expect(buildLockEmail(input({ fare: home })).text).toContain('You live in Nashville, so there’s no flight to book.')
  })

  it('no saved fare: says so and links a Google Flights search from their home airports', () => {
    const s = summarizeFare(input({ fare: null }))
    expect(s.kind).toBe('missing')
    expect(s.link?.url).toMatch(/^https:\/\/www\.google\.com\/travel\/flights\?q=Flights%20to%20BNA%20from%20BOS/)
    expect(summarizeFare(input({ fare: { ...fare, status: 'error', price: null } })).kind).toBe('missing')
  })

  it('an unsafe stored booking URL is replaced by a built Google Flights URL', () => {
    const s = summarizeFare(input({ fare: { ...fare, bookingUrl: 'javascript:alert(1)' } }))
    expect(s.link?.url).toMatch(/^https:\/\/www\.google\.com\/travel\/flights\?q=/)
  })

  it('refuses an invalid recipient address rather than sending somewhere odd', () => {
    expect(() =>
      buildLockEmail(input({ recipient: { displayName: 'B', email: 'a@b.test, c@d.test', homeAirports: [] } })),
    ).toThrow(/invalid recipient/)
  })
})

describe('helpers', () => {
  it('isEmailAddress', () => {
    expect(isEmailAddress('bob@example.test')).toBe(true)
    expect(isEmailAddress('bob.smith+trip@mail.example.com')).toBe(true)
    for (const bad of ['', 'bob', 'bob@', '@x.com', 'a b@x.com', 'a@x.com,b@y.com', 'a@x.com\nBcc: b@y.com', '<a@x.com>', null, 42]) {
      expect(isEmailAddress(bad), String(bad)).toBe(false)
    }
  })

  it('escapeHtml, oneLine, lockEmailKey, appUrlFor', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
    expect(oneLine('  a\n\tb‮ c  ')).toBe('a b c')
    expect(oneLine('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`)
    expect(lockEmailKey('t1', 'BNA', 'user_bob')).toBe('lock|t1|BNA|user_bob')
    expect(appUrlFor('halfway-pearl')).toBe('https://halfway-pearl.app.space')
  })
})
