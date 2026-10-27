// Scroll motion for both pages (GSAP + ScrollTrigger). Loaded before each page's own script, so the elements it
// takes over drop their CSS .reveal first. Without GSAP, or with reduced motion, the pages keep the plain reveal.
;(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---- a kite flying in the hero sky, on a string that sags as it moves ----
  for (const box of document.querySelectorAll('.kite-fly')) {
    const host = box.parentElement
    const string = box.querySelector('.string')
    const flyer = box.querySelector('.flyer-big')
    const tail = box.querySelector('.tail')
    const bows = [...box.querySelectorAll('.bows path')]
    const TAIL = 16
    let w = 0, h = 0
    const size = () => { w = host.clientWidth; h = host.clientHeight; box.setAttribute('viewBox', `0 0 ${w} ${h}`) }
    size()
    addEventListener('resize', size)
    const t0 = performance.now()
    const frame = (now) => {
      const t = reduce ? 0 : (now - t0) / 1000
      const lift = Math.min(scrollY, h) * 0.35
      const kx = w * (w < 700 ? 0.8 : 0.84) + Math.sin(t * 0.42) * 26 + Math.sin(t * 1.3) * 5
      const ky = h * 0.24 + Math.cos(t * 0.55) * 16 - lift
      const rot = Math.sin(t * 0.7) * 8 - 10
      flyer.setAttribute('transform', `translate(${kx} ${ky}) rotate(${rot})`)
      // the string is tied where the spars cross and falls off the bottom right corner
      const r = (rot * Math.PI) / 180, sin = Math.sin(r), cos = Math.cos(r)
      const knot = { x: kx + 6 * sin, y: ky - 6 * cos }
      const ax = w + 40, ay = h + 20
      const cx = (knot.x + ax) / 2 - 40 + Math.sin(t * 0.9) * 18, cy = Math.max(knot.y, ay) - 60 + Math.cos(t * 0.6) * 20
      string.setAttribute('d', `M${knot.x} ${knot.y} Q${cx} ${cy} ${ax} ${ay}`)
      // the tail hangs from the lower tip and streams downwind, away from the string, a wave running along it
      const tip = { x: kx - 26 * sin, y: ky + 26 * cos }
      const pts = []
      for (let i = 0; i <= TAIL; i++) {
        const k = i / TAIL, sway = Math.sin(t * 3.2 - i * 0.7) * 9 * k
        pts.push({ x: tip.x - i * 3.4 + sway, y: tip.y + i * 7.5 + sway * 0.3 })
      }
      let d = `M${pts[0].x} ${pts[0].y}`
      for (let i = 1; i < pts.length - 1; i++) {
        const m = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 }
        d += ` Q${pts[i].x} ${pts[i].y} ${m.x} ${m.y}`
      }
      tail.setAttribute('d', d)
      // a little bow tied across the tail at three points
      bows.forEach((bow, n) => {
        const i = 4 + n * 5, p = pts[i], q = pts[i + 1]
        const a = Math.atan2(q.y - p.y, q.x - p.x) + Math.PI / 2, ux = Math.cos(a), uy = Math.sin(a)
        const vx = (q.x - p.x) * 0.35, vy = (q.y - p.y) * 0.35
        bow.setAttribute('d', `M${p.x} ${p.y}L${p.x + ux * 6 - vx} ${p.y + uy * 6 - vy}L${p.x + ux * 6 + vx} ${p.y + uy * 6 + vy}ZM${p.x} ${p.y}L${p.x - ux * 6 - vx} ${p.y - uy * 6 - vy}L${p.x - ux * 6 + vx} ${p.y - uy * 6 + vy}Z`)
      })
      if (!reduce) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  if (reduce || !window.gsap || !window.ScrollTrigger) return
  gsap.registerPlugin(ScrollTrigger)
  const take = (els) => { for (const el of els) el.classList.remove('reveal') ; return els }
  const $ = (s, root = document) => [...root.querySelectorAll(s)]

  // split a heading into words (keeping the italic word italic) so they can rise one after another
  function words(h) {
    const walk = (node) => {
      for (const n of [...node.childNodes]) {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment()
          for (const part of n.textContent.split(/(\s+)/)) {
            if (!part) continue
            if (/^\s+$/.test(part)) { frag.append(part); continue }
            const s = document.createElement('span')
            s.className = 'w'
            s.innerHTML = `<span>${part}</span>`
            frag.append(s)
          }
          n.replaceWith(frag)
        } else if (n.nodeType === 1 && !n.classList.contains('w')) walk(n)
      }
    }
    walk(h)
    return $('.w > span', h)
  }

  // ---- hero: the words land, the sky drifts and the app tilts up out of the clouds as you scroll ----
  const hero = document.querySelector('.hero')
  if (hero) {
    const h1 = hero.querySelector('h1')
    h1.style.animation = 'none'
    gsap.from(words(h1), { yPercent: 110, rotate: 4, opacity: 0, filter: 'blur(10px)', duration: 1.1, ease: 'expo.out', stagger: 0.07, delay: 0.1 })
    const rim = hero.querySelector('.hero-shot .rim')
    gsap.set(rim, { transformPerspective: 1400, transformOrigin: '50% 100%' })
    const tl = gsap.timeline({ scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: 0.6 } })
    tl.fromTo(rim, { rotateX: 14, scale: 0.94 }, { rotateX: 0, scale: 1, ease: 'none' }, 0)
      .fromTo(hero, { backgroundPositionY: '64%' }, { backgroundPositionY: '30%', ease: 'none' }, 0)
      .to(hero.querySelector('.hero-copy'), { y: -120, opacity: 0, filter: 'blur(8px)', ease: 'none' }, 0)
  }

  // ---- section heads: the label pops, the words rise, the line fades up ----
  for (const head of take($('.head'))) {
    const tl = gsap.timeline({ scrollTrigger: { trigger: head, start: 'top 85%' } })
    tl.from(head.querySelector('.badge'), { y: 10, opacity: 0, scale: 0.85, duration: 0.6, ease: 'back.out(2)' })
      .from(words(head.querySelector('h2')), { yPercent: 110, opacity: 0, filter: 'blur(8px)', duration: 0.9, ease: 'expo.out', stagger: 0.05 }, '-=0.35')
    const p = head.querySelector('p')
    if (p) tl.from(p, { y: 14, opacity: 0, duration: 0.8, ease: 'power3.out' }, '-=0.6')
  }
  for (const h of $('.duo-copy h2, .closing h2')) {
    gsap.from(words(h), { yPercent: 110, opacity: 0, filter: 'blur(8px)', duration: 0.9, ease: 'expo.out', stagger: 0.05, scrollTrigger: { trigger: h, start: 'top 85%' } })
  }

  // ---- every sky drifts behind what sits on it ----
  for (const el of $('.sky-panel, .tile.sky')) {
    gsap.fromTo(el, { backgroundPositionY: '10%' }, { backgroundPositionY: '90%', ease: 'none', scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true } })
  }

  // ---- the showcase: tabs come in one by one, the app slides in from the right ----
  for (const sc of $('.showcase')) {
    take([sc])
    const tl = gsap.timeline({ scrollTrigger: { trigger: sc, start: 'top 80%' } })
    tl.from(sc, { y: 60, scale: 0.96, opacity: 0, duration: 1, ease: 'expo.out' })
      .from($('.tab', sc), { x: -30, opacity: 0, duration: 0.6, ease: 'power3.out', stagger: 0.06 }, '-=0.6')
      .from(sc.querySelector('.stage'), { x: 60, rotateY: -8, transformPerspective: 1200, opacity: 0, duration: 1, ease: 'expo.out' }, '<-0.2')
  }

  // ---- bento and tiles: rise with a little tilt, one after another ----
  for (const group of $('.bento, .coverage, .kinds')) {
    const items = take($(':scope > *', group))
    gsap.from(items, { y: 70, rotate: (i) => (i % 2 ? 2 : -2), opacity: 0, duration: 1, ease: 'expo.out', stagger: 0.1, scrollTrigger: { trigger: group, start: 'top 82%' } })
  }
  for (const f of $('.fact')) gsap.from(f, { scale: 0.9, opacity: 0, duration: 0.8, ease: 'back.out(1.6)', scrollTrigger: { trigger: f, start: 'top 90%' } })

  // ---- search: the console rises, its rows slide in ----
  for (const c of take($('.console'))) {
    const tl = gsap.timeline({ scrollTrigger: { trigger: c, start: 'top 80%' } })
    tl.from(c, { y: 50, opacity: 0, duration: 0.9, ease: 'expo.out' })
      .from($('.qrow', c), { x: -40, opacity: 0, duration: 0.6, ease: 'power3.out', stagger: 0.07 }, '-=0.5')
  }

  // ---- split: the halves come in from either side, then their rows ----
  for (const s of take($('.split'))) {
    const tl = gsap.timeline({ scrollTrigger: { trigger: s, start: 'top 80%' } })
    tl.from(s, { y: 40, opacity: 0, duration: 0.8, ease: 'expo.out' })
      .from(s.querySelector('.half.yes'), { x: -50, opacity: 0, duration: 0.9, ease: 'expo.out' }, '-=0.6')
      .from(s.querySelector('.half.no'), { x: 50, opacity: 0, duration: 0.9, ease: 'expo.out' }, '<')
      .from($('.op', s), { y: 16, opacity: 0, duration: 0.5, ease: 'power3.out', stagger: 0.05 }, '-=0.5')
      .from($('.op .ic', s), { scale: 0, duration: 0.5, ease: 'back.out(3)', stagger: 0.05 }, '<')
  }

  // ---- duo: the panel opens, the screen floats and leans toward the pointer ----
  for (const d of take($('.duo'))) {
    gsap.from(d, { y: 70, scale: 0.95, opacity: 0, duration: 1.1, ease: 'expo.out', scrollTrigger: { trigger: d, start: 'top 80%' } })
    const screen = d.querySelector('.showroom .rim')
    if (!screen) continue
    gsap.set(screen, { transformPerspective: 1100 })
    gsap.to(screen, { y: -10, duration: 3.2, ease: 'sine.inOut', yoyo: true, repeat: -1 })
    const rx = gsap.quickTo(screen, 'rotationX', { duration: 0.8, ease: 'power3.out' })
    const ry = gsap.quickTo(screen, 'rotationY', { duration: 0.8, ease: 'power3.out' })
    d.addEventListener('pointermove', (e) => {
      const r = screen.getBoundingClientRect()
      ry(((e.clientX - (r.left + r.width / 2)) / r.width) * 12)
      rx(-((e.clientY - (r.top + r.height / 2)) / r.height) * 10)
    })
    d.addEventListener('pointerleave', () => { rx(0); ry(0) })
  }

  // ---- faq: the questions drop in one by one ----
  for (const f of take($('.faq'))) {
    gsap.from(f, { y: 40, opacity: 0, duration: 0.9, ease: 'expo.out', scrollTrigger: { trigger: f, start: 'top 85%' } })
    gsap.from($('details', f), { y: 20, opacity: 0, duration: 0.6, ease: 'power3.out', stagger: 0.07, scrollTrigger: { trigger: f, start: 'top 80%' } })
  }

  // ---- closing: the sky opens out to the page's edges as it arrives ----
  for (const c of take($('.closing .sky-panel'))) {
    gsap.fromTo(c, { scale: 0.88, borderRadius: 56 }, { scale: 1, borderRadius: 28, ease: 'none', scrollTrigger: { trigger: c, start: 'top bottom', end: 'top 35%', scrub: 0.6 } })
    gsap.from($('.badge, p, .ctas', c), { y: 20, opacity: 0, duration: 0.8, ease: 'power3.out', stagger: 0.08, scrollTrigger: { trigger: c, start: 'top 70%' } })
  }

  // ---- buttons lean toward the pointer ----
  for (const b of $('.btn-lg:not(.soon)')) {
    const x = gsap.quickTo(b, 'x', { duration: 0.5, ease: 'power3.out' }), y = gsap.quickTo(b, 'y', { duration: 0.5, ease: 'power3.out' })
    b.addEventListener('pointermove', (e) => { const r = b.getBoundingClientRect(); x((e.clientX - r.left - r.width / 2) * 0.18); y((e.clientY - r.top - r.height / 2) * 0.25) })
    b.addEventListener('pointerleave', () => { x(0); y(0) })
  }
})()
