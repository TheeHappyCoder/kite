// The Kite bar, drawn from an activity's fields as Kite draws it. Shared by the Kite page and the Kite bar API page.
//   KiteBar.set(el, activity, { pill })   swap what it shows: the old fades, the sky eases to the new width, the new fades in (pill: resting, one button, no sheet)
//   KiteBar.update(el, activity)          same key: only the value and the lime line move
//   KiteBar.press(el, i, label)           a button pressed (Copy -> Copied)
//   KiteBar.waiting(el, n)                n chips waiting beside it on the sky
//   KiteBar.type(el, text)                text typed into the quick reply
//   <div class="kitebar" data-kitebar='{…}'> is drawn on load
window.KiteBar = (() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
  const ICONS = {
    bell: svg('<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
    deploy: svg('<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    bug: svg('<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8M3.5 13H7M17 13h3.5M4.5 8.5 7 10M19.5 8.5 17 10M4.5 18.5 7 17M19.5 18.5 17 17"/>'),
    timer: svg('<circle cx="12" cy="13.5" r="7"/><path d="M12 10v3.5l2.5 1.5M10 3h4"/>'),
    key: svg('<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M17 6l2.5 2.5M14.5 8.5 16.5 10.5"/>'),
    shield: svg('<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>'),
    calendar: svg('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>'),
    mail: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>'),
    send: svg('<path d="M4 12 20 4l-5 16-3.5-6.5L4 12Z"/><path d="m11.5 13.5 4-4"/>'),
    refresh: svg('<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>'),
  }
  const TINT = { success: 'ok', danger: 'warn', warning: 'warn' }
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  function icon(a) {
    if (a.avatar) return `<span class="ic av" style="--h:${a.hue ?? 255}">${esc(a.avatar)}</span>`
    return `<span class="ic ${TINT[a.tint] || ''}">${ICONS[a.icon] || ICONS.bell}</span>`
  }
  // the kite, white on the sky, with its lime tail
  const MARK = '<svg class="mark" viewBox="0 0 24 30" aria-hidden="true"><path d="M12 2 20 10 12 22 4 10Z" fill="rgba(255,255,255,0.28)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 10h16M12 2v20" stroke="#fff" stroke-opacity="0.8" stroke-width="1.1"/><path d="M12 22c-1.5 2.2 1.5 3.4 0 5.6" fill="none" stroke="#c6f56f" stroke-width="1.6" stroke-linecap="round"/></svg>'
  function value(a) {
    // a code lands digit by digit, a gap in the middle like the app's code input
    if (a.code) return `<span class="val code">${[...a.code].map((d, i) => `<i style="--d:${i}">${d}</i>`).join('')}</span>`
    if (a.val) return `<span class="val">${esc(a.val)}</span>`
    return ''
  }
  // progress fills the lime line; a countdown (ring) drains it
  const lineOf = (a) => (a.progress != null ? a.progress : a.ring != null ? a.ring : null)
  function row(a, pill) {
    const line = lineOf(a)
    return `<div class="row">${MARK}${icon(a)}${a.title ? `<span class="nt"><b>${esc(a.title)}</b>${!pill && a.sub ? `<span>${esc(a.sub)}</span>` : ''}</span>` : ''}${value(a)}`
      + (a.actions ? `<span class="acts">${a.actions.map((x) => `<span>${esc(x)}</span>`).join('')}</span>` : '')
      + '<span class="chips"></span></div>'
      + (line != null ? `<span class="line"><i style="width:${line * 100}%"></i></span>` : '')
  }
  function sheet(a) {
    if (a.body == null && a.reply == null) return ''
    return (a.body != null ? `<div class="body">${esc(a.body)}</div>` : '')
      + (a.reply != null ? `<div class="reply"><span class="txt">${esc(a.reply)}</span><span class="caret"></span></div>` : '')
  }

  function set(el, a, { pill = false } = {}) {
    let clip = el.querySelector(':scope > .clip')
    if (!clip) { el.insertAdjacentHTML('afterbegin', '<div class="clip"><div class="swap"></div></div><div class="sheet" hidden></div>'); clip = el.firstElementChild }
    const paper = el.querySelector(':scope > .sheet')
    const old = clip.querySelector('.swap')
    const chips = old.querySelector('.chips')?.innerHTML || ''
    const go = () => {
      const w0 = clip.offsetWidth
      clip.style.width = ''
      el.classList.toggle('pill', pill)
      clip.innerHTML = `<div class="swap fade">${row(a, pill)}</div>`
      const kept = clip.querySelector('.chips')
      kept.innerHTML = chips
      kept.classList.toggle('on', chips !== '')
      const words = sheet(a)
      paper.innerHTML = words
      paper.hidden = !words
      const sw = clip.firstChild
      if (reduce) { sw.classList.remove('fade'); return }
      const w1 = clip.offsetWidth
      clip.style.transition = 'none'
      clip.style.width = `${w0}px`
      void clip.offsetWidth // a read forces layout, so the transition starts from the old width
      clip.style.transition = 'width 0.6s var(--spring)'
      clip.style.width = `${w1}px`
      requestAnimationFrame(() => sw.classList.remove('fade'))
      clearTimeout(clip.t)
      clip.t = setTimeout(() => { clip.style.width = '' }, 650)
    }
    if (reduce || !old.innerHTML) return go()
    old.classList.add('fade')
    setTimeout(go, 200)
  }
  function update(el, a) {
    const line = el.querySelector('.line i'), val = el.querySelector('.val')
    const fill = lineOf(a)
    if (line && fill != null) line.style.width = `${fill * 100}%`
    if (val && a.val != null) val.textContent = a.val
  }
  function press(el, i, label) {
    const b = el.querySelectorAll('.acts span')[i]
    if (!b) return
    b.classList.add('pressed')
    if (label) b.innerHTML = `${ICONS.check}${esc(label)}`
  }
  function waiting(el, n) {
    const chips = el.querySelector('.chips')
    if (!chips) return
    chips.innerHTML = n > 0 ? `<span>${n} waiting</span>` : ''
    chips.classList.toggle('on', n > 0)
  }
  async function type(el, text) {
    const t = el.querySelector('.sheet .reply .txt')
    if (!t) return
    if (reduce) { t.textContent = text; return }
    for (let k = 1; k <= text.length; k++) { t.textContent = text.slice(0, k); await wait(34 + Math.random() * 40) }
  }

  // drawn on load; one with `tick` runs its lime line down by itself
  for (const el of document.querySelectorAll('[data-kitebar]')) {
    const a = JSON.parse(el.dataset.kitebar)
    set(el, a)
    if (a.tick && !reduce) {
      let left = a.tick
      setInterval(() => { left = left > 0 ? left - 1 : a.tick; update(el, { val: mmss(left), ring: left / a.tick }) }, 1000)
    }
  }
  return { ICONS, set, update, press, waiting, type, mmss, wait, reduce }
})()
