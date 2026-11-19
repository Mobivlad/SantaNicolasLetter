/* Fairy-tale night sky: twinkling stars, crystal snowflakes, shooting stars,
   magic dust under the finger and a blinking garland. Shared by index.html and link.html. */
(function () {
  "use strict";

  const canvas = document.getElementById("sky");
  if (!canvas) return;
  const g = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TAU = Math.PI * 2;

  let W = 0, H = 0, dpr = 1;
  let stars = [], flakes = [], meteors = [], dust = [];
  let nextMeteor = 3, wind = 0, time = 0, last = 0;

  /* ---------- pre-rendered sprites (drawImage is much cheaper than paths) ---------- */
  function sprite(size, draw) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const x = c.getContext("2d");
    x.translate(size / 2, size / 2);
    draw(x, size / 2);
    return c;
  }

  const CRYSTAL_R = 24; // arm length inside the 64 px sprite
  const BRANCHES = [
    [[0.45, 0.32], [0.72, 0.22]],
    [[0.32, 0.2], [0.58, 0.34], [0.82, 0.16]],
    [[0.55, 0.4]]
  ];
  const crystals = BRANCHES.map((br, v) => sprite(64, (x) => {
    const R = CRYSTAL_R;
    x.strokeStyle = "#fff";
    x.fillStyle = "#fff";
    x.lineCap = "round";
    x.shadowColor = "rgba(185, 220, 255, .95)";
    x.shadowBlur = 6;
    x.lineWidth = 2.6;
    x.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i * TAU) / 6, s = Math.sin(a), c = Math.cos(a);
      const pt = (px, py) => [px * c - py * s, px * s + py * c]; // rotate (px, py) by a
      x.moveTo(0, 0); x.lineTo(...pt(0, -R));
      for (const [p, l] of br) {
        x.moveTo(...pt(0, -R * p)); x.lineTo(...pt(-R * l * 0.87, -R * p - R * l * 0.5));
        x.moveTo(...pt(0, -R * p)); x.lineTo(...pt(R * l * 0.87, -R * p - R * l * 0.5));
      }
    }
    if (v === 2) { // little hexagon in the middle
      for (let i = 0; i <= 6; i++) {
        const a = (i * TAU) / 6;
        x[i ? "lineTo" : "moveTo"](Math.sin(a) * R * 0.3, -Math.cos(a) * R * 0.3);
      }
    }
    x.stroke();
    x.beginPath(); x.arc(0, 0, 2.6, 0, TAU); x.fill();
  }));

  function sparkleSprite(rgb) {
    return sprite(48, (x, c) => {
      const gr = x.createRadialGradient(0, 0, 0, 0, 0, c);
      gr.addColorStop(0, `rgba(${rgb},.9)`);
      gr.addColorStop(0.22, `rgba(${rgb},.32)`);
      gr.addColorStop(1, `rgba(${rgb},0)`);
      x.fillStyle = gr;
      x.fillRect(-c, -c, 2 * c, 2 * c);
      const L = c * 0.95, w = c * 0.1;
      x.fillStyle = "#fff";
      x.beginPath();
      x.moveTo(0, -L);
      x.quadraticCurveTo(w, -w, L, 0);
      x.quadraticCurveTo(w, w, 0, L);
      x.quadraticCurveTo(-w, w, -L, 0);
      x.quadraticCurveTo(-w, -w, 0, -L);
      x.fill();
    });
  }
  const sparkGold = sparkleSprite("255,214,120");
  const sparkIce = sparkleSprite("170,215,255");
  const sparkPink = sparkleSprite("255,170,230");

  function drawSprite(img, x, y, size, rot, alpha) {
    g.globalAlpha = alpha;
    if (rot) {
      g.save(); g.translate(x, y); g.rotate(rot);
      g.drawImage(img, -size / 2, -size / 2, size, size);
      g.restore();
    } else {
      g.drawImage(img, x - size / 2, y - size / 2, size, size);
    }
  }

  /* ---------- stars & snow ---------- */
  function makeStars() {
    const n = Math.min(320, Math.round((W * H) / 2600));
    stars = Array.from({ length: n }, () => {
      const r = Math.random() * 1.3 + 0.3;
      return {
        x: Math.random(), y: Math.pow(Math.random(), 1.4) * 0.75, r,
        a: Math.random() * 0.6 + 0.3,
        s: Math.random() * 2 + 0.6, p: Math.random() * TAU,
        img: r > 1.3 ? (Math.random() < 0.35 ? sparkGold : sparkIce) : null
      };
    });
  }

  function newFlake(top) {
    const depth = Math.random();
    const crystal = depth > 0.55;
    const size = crystal ? 4 + ((depth - 0.55) / 0.45) * 7 : 0.8 + depth * 2.2; // crystal: arm length, dot: radius
    return {
      x: Math.random() * W, y: top ? -14 - Math.random() * 40 : Math.random() * H,
      size, crystal, img: crystals[(Math.random() * crystals.length) | 0],
      vy: crystal ? 20 + size * 4.5 : 18 + size * 16,
      amp: 10 + Math.random() * 25, f: 0.4 + Math.random() * 1.2, p: Math.random() * TAU,
      a: crystal ? 0.7 + Math.random() * 0.3 : 0.4 + depth * 0.6,
      rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 1.4
    };
  }

  function makeFlakes() {
    const target = Math.round(Math.min(220, (W * H) / 7000) * (reduceMotion ? 0.35 : 1));
    while (flakes.length < target) flakes.push(newFlake(false));
    flakes.length = target;
  }

  let lastW = 0, lastH = 0;
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    // iOS changes innerHeight while scrolling (toolbar); reallocating the canvas then costs a frame
    // and clears it. Small height changes are absorbed by the CSS stretch instead.
    if (w === lastW && Math.abs(h - lastH) < 120) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = w; H = h; lastH = h;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (W !== lastW) { makeStars(); lastW = W; }
    makeFlakes();
  }

  /* ---------- magic dust ---------- */
  function spawnDust(x, y, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, v = Math.random() * speed;
      const k = Math.random();
      dust.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 25,
        life: 0, max: 0.6 + Math.random() * 0.9,
        size: 8 + Math.random() * 14, rot: Math.random() * TAU,
        img: k < 0.6 ? sparkGold : k < 0.85 ? sparkIce : sparkPink
      });
    }
    if (dust.length > 350) dust.splice(0, dust.length - 350);
  }

  let lastTrail = 0;
  function trail(x, y) {
    const now = performance.now();
    if (now - lastTrail < 25) return;
    lastTrail = now;
    spawnDust(x, y, 2, 40);
  }

  if (!reduceMotion) {
    window.addEventListener("pointerdown", (e) => spawnDust(e.clientX, e.clientY, 12, 110), { passive: true });
    window.addEventListener("pointermove", (e) => { if (e.pointerType !== "touch") trail(e.clientX, e.clientY); }, { passive: true });
    window.addEventListener("touchmove", (e) => { const t = e.touches[0]; if (t) trail(t.clientX, t.clientY); }, { passive: true });
  }

  /* ---------- frame ---------- */
  const MIN_STEP = reduceMotion ? 1000 / 15 : 0; // reduced motion: a calm, low-rate sky
  function frame(ts) {
    requestAnimationFrame(frame);
    if (ts - last < MIN_STEP) return;
    const dt = Math.min(0.05, (ts - last) / 1000 || 0);
    last = ts; time += dt;
    wind = Math.sin(time * 0.15) * 18 + Math.sin(time * 0.37) * 8;
    g.clearRect(0, 0, W, H);

    g.fillStyle = "#fff";
    for (const s of stars) {
      const a = s.a * (0.6 + 0.4 * Math.sin(time * s.s + s.p));
      if (s.img) {
        drawSprite(s.img, s.x * W, s.y * H, s.r * 9 * (0.8 + 0.25 * Math.sin(time * s.s + s.p)), 0, a);
      } else {
        g.globalAlpha = a;
        g.beginPath();
        g.arc(s.x * W, s.y * H, s.r, 0, TAU);
        g.fill();
      }
    }

    if (!reduceMotion) {
      nextMeteor -= dt;
      if (nextMeteor <= 0) {
        nextMeteor = 4 + Math.random() * 6;
        const speed = 600 + Math.random() * 300;
        meteors.push({ x: W * (0.3 + Math.random() * 0.8), y: H * Math.random() * 0.25,
          vx: -speed * 0.85, vy: speed * 0.45, life: 0, max: 0.9 });
      }
      meteors = meteors.filter((m) => {
        m.life += dt; m.x += m.vx * dt; m.y += m.vy * dt;
        const k = 1 - m.life / m.max;
        if (k <= 0) return false;
        const tail = 0.18;
        const grad = g.createLinearGradient(m.x, m.y, m.x - m.vx * tail, m.y - m.vy * tail);
        grad.addColorStop(0, `rgba(255,240,200,${k})`);
        grad.addColorStop(1, "rgba(255,240,200,0)");
        g.globalAlpha = 1;
        g.strokeStyle = grad;
        g.lineWidth = 2.2;
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(m.x, m.y);
        g.lineTo(m.x - m.vx * tail, m.y - m.vy * tail);
        g.stroke();
        drawSprite(sparkGold, m.x, m.y, 22, m.life * 4, k);
        if (Math.random() < 0.5) dust.push({ x: m.x, y: m.y, vx: 0, vy: 10, life: 0, max: 0.5, size: 7, rot: 0, img: sparkGold });
        return true;
      });
    }

    g.fillStyle = "#fff";
    const slow = reduceMotion ? 0.4 : 1;
    for (let i = 0; i < flakes.length; i++) {
      const f = flakes[i];
      f.y += f.vy * dt * slow;
      f.x += (wind * (f.crystal ? 0.9 : f.size / 3) + Math.cos(time * f.f + f.p) * f.amp * 0.6) * dt;
      if (f.y > H + 14) { flakes[i] = newFlake(true); continue; }
      if (f.x > W + 14) f.x = -14; else if (f.x < -14) f.x = W + 14;
      if (f.crystal) {
        f.rot += f.vr * dt * slow;
        drawSprite(f.img, f.x, f.y, (f.size * 64) / CRYSTAL_R, f.rot, f.a);
      } else {
        g.globalAlpha = f.a;
        g.beginPath();
        g.arc(f.x, f.y, f.size, 0, TAU);
        g.fill();
      }
    }

    if (dust.length) {
      g.globalCompositeOperation = "lighter";
      dust = dust.filter((d) => {
        d.life += dt;
        const k = 1 - d.life / d.max;
        if (k <= 0) return false;
        d.vx *= 0.97; d.vy = d.vy * 0.97 + 30 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.rot += dt * 2;
        drawSprite(d.img, d.x, d.y, d.size * (0.4 + 0.6 * k), d.rot, k * (0.75 + 0.25 * Math.sin(d.life * 30)));
        return true;
      });
      g.globalCompositeOperation = "source-over";
    }

    g.globalAlpha = 1;
  }

  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(frame);

  /* ---------- garland across the top of the screen ---------- */
  (function garland() {
    const el = document.createElement("div");
    el.className = "garland";
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    const COLORS = ["#ff4d6d", "#ffd36b", "#5dffa0", "#6bc7ff", "#d58bff"];
    let builtW = 0;

    function build() {
      const w = window.innerWidth;
      if (w === builtW) return;
      builtW = w;
      const swags = Math.max(2, Math.round(w / 170)), sw = w / swags, sag = 16, top = 2;
      let d = "";
      for (let i = 0; i < swags; i++) d += `M${i * sw} ${top} Q${i * sw + sw / 2} ${top + 2 * sag} ${(i + 1) * sw} ${top} `;
      let html = `<svg width="${w}" height="${top + sag + 4}"><path d="${d}" fill="none" stroke="#14261b" stroke-width="1.6"/></svg>`;
      const n = Math.round(w / 30);
      for (let i = 0; i < n; i++) {
        const x = ((i + 0.5) * w) / n, t = (x % sw) / sw;
        const y = top + 4 * sag * t * (1 - t); // the quadratic swag is a parabola
        html += `<i class="bulb" style="left:${x.toFixed(1)}px;top:${(y + 1).toFixed(1)}px;--c:${COLORS[i % COLORS.length]};animation-delay:${(-(i % 4) * 0.45 - Math.random() * 0.3).toFixed(2)}s"></i>`;
      }
      el.innerHTML = html;
    }
    window.addEventListener("resize", build);
    build();
  })();

  window.Sky = {
    burst(x, y, n) { if (!reduceMotion) spawnDust(x, y, n || 40, 220); }
  };
})();

// Contact address is assembled at runtime so simple bots can't scrape it
document.querySelectorAll("a.mail[data-u]").forEach((a) => {
  const addr = a.dataset.u + "@" + a.dataset.d;
  a.href = "mailto:" + addr;
  a.textContent = addr;
});