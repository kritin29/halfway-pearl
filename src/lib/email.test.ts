import { describe, expect, it } from 'vitest'
import {
  appUrlFor,
  buildDropEmail,
  buildLockEmail,
  buildUnderBudgetEmail,
  dropEmailKey,
  underBudgetEmailKey,
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

describe('watch emails', () => {
  const base = {
    appUrl: 'https://halfway-pearl.app.space',
    tripId: 'trip_1',
    tripName: 'Spring <b>break</b>',
    outboundDate: '2026-12-11',
    returnDate: '2026-12-13',
  }

  it('keys: a group drop is per run and person; the private email is per destination and person, with no date', () => {
    expect(dropEmailKey('trip_1', 'job_9', 'user_bob')).toBe('drop|trip_1|job_9|user_bob')
    expect(underBudgetEmailKey('trip_1', 'BNA', 'user_bob')).toBe('under|trip_1|BNA|user_bob')
  })

  it('group drop email: one recipient, old → new group total, their own fare, escaped, link to the trip', () => {
    const msg = buildDropEmail({
      ...base,
      recipient: { displayName: 'Bob', email: 'bob@example.test' },
      drops: [{ iata: 'BNA', city: 'Nashville', previousTotal: 900, currentTotal: 820, yourFare: 187 }],
    })
    expect(msg.to).toBe('bob@example.test')
    expect(msg.subject).toBe('Halfway: Nashville got $80 cheaper for Spring <b>break</b>')
    expect(msg.text).toContain('Nashville (BNA): group total $900 → $820 ($80 less)')
    expect(msg.text).toContain('Your fare: $187 round trip.')
    expect(msg.text).toContain('https://halfway-pearl.app.space/t/trip_1')
    expect(msg.html).toContain('Spring &lt;b&gt;break&lt;/b&gt;')
    expect(msg.html).not.toContain('<b>break</b>')
    expect(`${msg.text}${msg.html}`.toLowerCase()).not.toContain('budget')
  })

  it('group drop email with several destinations, and for someone who lives there', () => {
    const msg = buildDropEmail({
      ...base,
      recipient: { displayName: 'Grandpa', email: 'g@example.test' },
      drops: [
        { iata: 'BNA', city: 'Nashville', previousTotal: 900, currentTotal: 820, yourFare: 0 },
        { iata: 'AUS', city: 'Austin', previousTotal: 1500, currentTotal: 1400, yourFare: null },
      ],
    })
    expect(msg.subject).toBe('Halfway: fares dropped for Spring <b>break</b>')
    expect(msg.text).toContain('You live there: no flight needed.')
    expect(msg.text).toContain('Austin (AUS): group total $1,500 → $1,400 ($100 less)')
  })

  it('refuses a bad address or an empty drop list', () => {
    expect(() => buildDropEmail({ ...base, recipient: { displayName: 'x', email: 'a@b.c, d@e.f' }, drops: [{ iata: 'BNA', city: 'N', previousTotal: 1, currentTotal: 0, yourFare: null }] })).toThrow()
    expect(() => buildDropEmail({ ...base, recipient: { displayName: 'x', email: 'a@b.co' }, drops: [] })).toThrow()
  })

  it('private email: says it fits their budget without the amount, names nobody else, safe booking link', () => {
    const msg = buildUnderBudgetEmail({
      ...base,
      destination: { iata: 'BNA', city: 'Nashville' },
      recipient: { displayName: 'Bob', email: 'bob@example.test', homeAirports: ['BOS'] },
      fare,
    })
    expect(msg.to).toBe('bob@example.test')
    expect(msg.subject).toBe('Halfway: your fare to Nashville now fits your budget')
    expect(msg.text).toContain('from BOS to Nashville (BNA) is now $187, within the private budget you set')
    expect(msg.text).toContain('Only you get this email.')
    expect(msg.text).toContain('https://www.google.com/travel/flights?tfs=abc123')
    // The builder takes no budget, so no other dollar amount can appear.
    expect(msg.text.match(/\$\d+(?:,\d{3})*/g)).toEqual(['$187'])

    const unsafe = buildUnderBudgetEmail({
      ...base,
      destination: { iata: 'BNA', city: 'Nashville' },
      recipient: { displayName: 'Bob', email: 'bob@example.test', homeAirports: ['BOS'] },
      fare: { ...fare, bookingUrl: 'javascript:alert(1)' },
    })
    expect(unsafe.text).not.toContain('javascript:')
    expect(unsafe.text).toContain('https://www.google.com/travel/flights?q=')
  })
})
