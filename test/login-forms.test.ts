import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileLoginForms } from '../scripts/build-login-hook.mjs'
import { findChrome, openHeadlessPage, type HeadlessPage } from './helpers/headless-page'

type Message =
  | { kind: 'capture'; username: string; password: string }
  | { kind: 'username'; username: string }
  | { kind: 'focus'; id: string | null }

const chrome = findChrome()
const lib = compileLoginForms()
const WATCH = `(()=>{${lib};
  const say = (message) => report(JSON.stringify(message))
  nccLogin.watchLogins({
    capture: (login) => say({ kind: 'capture', ...login }),
    username: (username) => say({ kind: 'username', username }),
    focus: (field) => say({ kind: 'focus', id: field ? field.id : null })
  })
})()`

const U = '<input id=u type=email autocomplete=username>'
const P = '<input id=p type=password autocomplete=current-password>'
const STAY = 'onsubmit="event.preventDefault()"'

describe.skipIf(!chrome)('login forms in a real page', { timeout: 20_000 }, () => {
  let page: HeadlessPage<Message>
  beforeAll(async () => { page = await openHeadlessPage<Message>(chrome!) }, 20_000)
  afterAll(() => page?.close())

  const open = async (html: string): Promise<void> => {
    await page.load(html)
    await page.run(WATCH)
    await page.sleep(300)
  }
  const captures = () => page.messages.filter((message) => message.kind === 'capture')
  const signIn = async (button = '#go'): Promise<void> => {
    await page.type('#u', 'al@x.io')
    await page.type('#p', 'pw1')
    await page.click(button)
  }

  describe('offering to save', () => {
    const cases: [string, string, () => Promise<void>][] = [
      ['a plain form', `<form ${STAY}>${U}${P}<button id=go>Sign in</button></form>`, () => signIn()],
      ['a button handled by script, with no form', `<div>${U}${P}<button id=go type=button>Log in</button></div>`, () => signIn()],
      ['a form that signs in with fetch', `<form>${U}${P}<button id=go type=button>Sign in</button></form>`, () => signIn()],
      ['Enter handled by script', `<div>${U}${P}</div>`, async () => { await page.type('#u', 'al@x.io'); await page.type('#p', 'pw1'); await page.enter() }],
      ['a script calling form.submit()', `<form id=f action=/next>${U}${P}<a href="#" id=go onclick="f.submit();return false">Go</a></form>`, () => signIn()],
      ['an unlabelled element, then the form leaves', `<div id=box>${U}${P}<div id=go onclick="setTimeout(()=>box.remove(),100)" style="width:80px;height:30px">&rarr;</div></div>`, () => signIn()],
      ['an open shadow root', `<div id=host></div><script>host.attachShadow({mode:'open'}).innerHTML='<form onsubmit="event.preventDefault()">${U}${P}<button id=go>Sign in</button></form>'</script>`, async () => { await page.type('#host >>> #u', 'al@x.io'); await page.type('#host >>> #p', 'pw1'); await page.click('#host >>> #go') }],
      ['a password change, with the new password', `<form ${STAY}>${U}<input id=o type=password autocomplete=current-password><input id=n type=password autocomplete=new-password><input id=c type=password autocomplete=new-password><button id=go>Update password</button></form>`, async () => { await page.type('#u', 'al@x.io'); await page.type('#o', 'old'); await page.type('#n', 'pw1'); await page.type('#c', 'pw1'); await page.click('#go') }],
      ['a hidden account field on the password step', `<form ${STAY}><input autocomplete=username value="al@x.io" style="display:none">${P}<button id=go>Sign in</button></form>`, async () => { await page.type('#p', 'pw1'); await page.click('#go') }]
    ]
    it.each(cases)('reads a login from %s, once', async (_name, html, act) => {
      await open(html)
      await act()
      await page.sleep(600)
      expect(captures()).toEqual([{ kind: 'capture', username: 'al@x.io', password: 'pw1' }])
    })

    const quiet: [string, string, () => Promise<void>][] = [
      ['Show password is pressed', `<div>${U}${P}<button id=eye type=button aria-label="Show password">Show</button></div>`, () => signIn('#eye')],
      ['Forgot password is pressed', `<form ${STAY}>${U}${P}<button id=eye type=button>Forgot password?</button><button>Sign in</button></form>`, () => signIn('#eye')],
      ['a page script set the password', `<form ${STAY}>${U}<input id=p type=password value=planted><button id=go type=button>Sign in</button></form>`, () => page.click('#go')],
      ['the confirmation does not match', `<form ${STAY}>${U}<input id=n type=password autocomplete=new-password><input id=c type=password autocomplete=new-password><button id=go>Sign up</button></form>`, async () => { await page.type('#n', 'pw1'); await page.type('#c', 'pw2'); await page.click('#go') }],
      ['the form re-renders while typing', `<div id=box>${U}${P}</div><script>document.addEventListener('input',(e)=>{if(e.target.id==='p'&&!e.target.dataset.done){const next=e.target.cloneNode();next.dataset.done=1;next.value=e.target.value;e.target.replaceWith(next)}})</script>`, async () => { await page.click('#u'); await page.type('#p', 'pw1') }]
    ]
    it.each(quiet)('stays quiet when %s', async (_name, html, act) => {
      await open(html)
      await act()
      await page.sleep(600)
      expect(captures()).toEqual([])
    })

    it('offers again after a corrected password', async () => {
      await open(`<form ${STAY}>${U}${P}<button id=go>Sign in</button></form>`)
      await signIn()
      await page.type('#p', '2')
      await page.click('#go')
      expect(captures().map((message) => message.kind === 'capture' && message.password.length)).toEqual([3, 4])
    })

    it('reports the account from a username-only step', async () => {
      await open(`<form ${STAY}><input id=u type=email autocomplete=username><button id=go>Next</button></form>`)
      await page.type('#u', 'al@x.io')
      await page.click('#go')
      expect(page.messages).toContainEqual({ kind: 'username', username: 'al@x.io' })
      expect(captures()).toEqual([])
    })
  })

  describe('offering to fill', () => {
    const lastFocus = () => page.messages.filter((message) => message.kind === 'focus').at(-1)

    it('follows focus into and out of a login form', async () => {
      await open(`<input id=q type=text name=q placeholder=Search><form>${U}${P}</form>`)
      await page.click('#u')
      expect(lastFocus()).toEqual({ kind: 'focus', id: 'u' })
      await page.click('#q')
      expect(lastFocus()).toEqual({ kind: 'focus', id: null })
      await page.click('#p')
      expect(lastFocus()).toEqual({ kind: 'focus', id: 'p' })
    })

    it('notices an autofocused password field', async () => {
      await open(`<form>${U}<input id=p type=password autofocus></form>`)
      expect(lastFocus()).toEqual({ kind: 'focus', id: 'p' })
    })

    it('does not offer a saved password to a signup form', async () => {
      await open('<form><input id=u type=email><input id=a type=password autocomplete=new-password><input id=b type=password autocomplete=new-password></form>')
      await page.click('#u')
      await page.click('#a')
      expect(page.messages.filter((message) => message.kind === 'focus' && message.id)).toEqual([])
    })

    const fills: [string, string, Record<string, string>, string][] = [
      ['a plain form', `<form>${U}${P}</form>`, { '#u': 'al@x.io', '#p': 'pw1' }, 'filled'],
      ['a username-only step', '<form><input id=u type=email autocomplete=username><button>Next</button></form>', { '#u': 'al@x.io' }, 'username'],
      ['an open shadow root', `<div id=host></div><script>host.attachShadow({mode:'open'}).innerHTML='<form>${U}${P}</form>'</script>`, { '#host >>> #u': 'al@x.io', '#host >>> #p': 'pw1' }, 'filled'],
      ['the sign-in form below a signup form', `<form><input id=sn type=text name=newname><input id=sp type=password autocomplete=new-password></form><form>${U}${P}</form>`, { '#u': 'al@x.io', '#p': 'pw1', '#sn': '', '#sp': '' }, 'filled'],
      ['a login below a search box', '<input id=q type=search><input id=s type=text name=q placeholder=Search><form><input id=u type=text name=login><input id=p type=password></form>', { '#u': 'al@x.io', '#p': 'pw1', '#q': '', '#s': '' }, 'filled'],
      ['a form with a hidden trap field', `<form><input type=password id=trap style="opacity:0;position:absolute;left:-9999px">${U}${P}</form>`, { '#u': 'al@x.io', '#p': 'pw1', '#trap': '' }, 'filled'],
      ['a page with no login', '<form><input id=s type=text name=search><input id=c type=text name=comment></form>', { '#s': '', '#c': '' }, 'none']
    ]
    it.each(fills)('fills %s', async (_name, html, values, result) => {
      await open(html)
      expect(await page.run(`(()=>{${lib};return nccLogin.fillLogin('al@x.io','pw1')})()`)).toBe(result)
      for (const [selector, value] of Object.entries(values)) expect(await page.value(selector), selector).toBe(value)
    })

    it('does not offer to save what the browser filled', async () => {
      await open(`<form ${STAY}>${U}${P}<button id=go type=button>Help</button></form>`)
      await page.run(`(()=>{${lib};return nccLogin.fillLogin('al@x.io','pw1')})()`)
      await page.click('#go')
      expect(captures()).toEqual([])
    })
  })
})
