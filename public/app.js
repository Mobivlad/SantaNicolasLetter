(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ================= Screens & music ================= */
  const intro = $("#intro"), letterScreen = $("#letterScreen"), sent = $("#sent");
  const musicBtn = $("#musicBtn");
  let linkUsed = false; // the personal link has already sent its letter

  function updateMusicBtn() {
    const on = window.Music.enabled;
    musicBtn.textContent = on ? "🔔" : "🔕";
    musicBtn.setAttribute("aria-pressed", String(on));
    musicBtn.setAttribute("aria-label", on ? "Вимкнути музику" : "Увімкнути музику");
  }

  musicBtn.addEventListener("click", () => { window.Music.toggle(); updateMusicBtn(); });

  function openLetter() {
    window.Music.start();
    musicBtn.hidden = false;
    updateMusicBtn();
    $("#envelope").classList.add("open");
    const r = $("#envelope").getBoundingClientRect();
    if (window.Sky) window.Sky.burst(r.left + r.width / 2, r.top + r.height * 0.4, 60);
    intro.classList.add("leaving");
    setTimeout(() => {
      intro.hidden = true;
      if (linkUsed) return;
      letterScreen.hidden = false;
      growAll();
      window.scrollTo(0, 0);
    }, reduceMotion ? 50 : 1600);
  }
  let opened = false;
  for (const btn of [$("#openBtn"), $("#freeBtn")]) {
    btn.addEventListener("click", () => { if (!opened) { opened = true; openLetter(); } });
  }

  /* ================= Letter form ================= */
  const form = $("#letter");
  const nameEl = $("#name"), ageEl = $("#age"), cityEl = $("#city"), aboutEl = $("#about"), goodEl = $("#good");
  const wishesEl = $("#wishes"), addWishBtn = $("#addWish");
  const errorEl = $("#formError"), sendBtn = $("#sendBtn");
  const MAX_WISHES = 10;
  // Personal link: index.html?l=<token>; the server decrypts it (name -> /api/open, parent's email stays server-side)
  const linkToken = new URLSearchParams(location.search).get("l") || "";
  // Own draft per link: siblings on one phone must not see each other's wishes
  const DRAFT_KEY = "mykolai-letter-draft" + (linkToken ? "-" + linkToken : "");
  let urlName = "";
  const locked = { age: "", city: "" }; // filled in by parents via the link: the child cannot change them
  const ICONS = ["🎁", "🧸", "🚲", "📚", "🎨", "🪀", "🛷", "⭐", "🍬", "🎄"];
  const PLACEHOLDERS = ["Наприклад: санчата", "Наприклад: книжка", "Наприклад: ведмедик", "Ще одне бажання…"];

  function addWish(value, focus) {
    if (wishesEl.children.length >= MAX_WISHES) return;
    const i = wishesEl.children.length;
    const li = document.createElement("li");
    li.className = "wish";
    li.innerHTML =
      `<span class="wish-icon" aria-hidden="true">${ICONS[i % ICONS.length]}</span>` +
      `<textarea class="wish-text" rows="1" maxlength="120" enterkeyhint="next" aria-label="Бажання ${i + 1}"></textarea>` +
      `<button type="button" class="wish-del" aria-label="Видалити бажання">×</button>`;
    const input = li.querySelector(".wish-text");
    input.placeholder = PLACEHOLDERS[Math.min(i, PLACEHOLDERS.length - 1)];
    input.value = value || "";
    wishesEl.appendChild(li);
    grow(input);
    refreshWishes();
    if (focus) input.focus();
  }

  const wishInputs = () => [...wishesEl.querySelectorAll(".wish-text")];

  function refreshWishes() {
    const items = [...wishesEl.children];
    items.forEach((li, i) => {
      li.querySelector(".wish-icon").textContent = ICONS[i % ICONS.length];
      li.querySelector(".wish-text").setAttribute("aria-label", `Бажання ${i + 1}`);
      li.querySelector(".wish-del").hidden = items.length === 1;
    });
    addWishBtn.disabled = items.length >= MAX_WISHES;
    addWishBtn.textContent = items.length >= MAX_WISHES ? "Досить бажань на цей рік 😉" : "+ додати бажання";
  }

  addWishBtn.addEventListener("click", () => addWish("", true));

  wishesEl.addEventListener("click", (e) => {
    const del = e.target.closest(".wish-del");
    if (!del) return;
    del.closest(".wish").remove();
    refreshWishes();
    saveDraft();
  });

  wishesEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches(".wish-text")) return;
    e.preventDefault();
    const li = e.target.closest(".wish");
    const next = li.nextElementSibling;
    if (next) next.querySelector(".wish-text").focus();
    else if (e.target.value.trim()) addWish("", true);
  });

  // A wish is one line of text that wraps visually; pasted line breaks become spaces
  wishesEl.addEventListener("input", (e) => {
    if (!e.target.matches(".wish-text")) return;
    if (/[\r\n]/.test(e.target.value)) e.target.value = e.target.value.replace(/\s*[\r\n]+\s*/g, " ");
    grow(e.target);
  });

  // Enter moves to the next editable field
  [nameEl, ageEl, cityEl].forEach((el) => el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const next = [ageEl, cityEl].find((f) => f !== el && !f.readOnly && f.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)
      || wishesEl.querySelector(".wish-text");
    if (next) next.focus();
  }));
  ageEl.addEventListener("input", () => { ageEl.value = ageEl.value.replace(/\D/g, "").slice(0, 2); });

  function grow(el) {
    if (!el.offsetParent) return; // hidden: no layout yet, growAll() runs when shown
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }
  function growAll() {
    grow(aboutEl);
    wishInputs().forEach(grow);
  }
  aboutEl.addEventListener("input", () => grow(aboutEl));
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return; // ignore iOS keyboard / toolbar height changes
    lastWidth = window.innerWidth;
    growAll();
  });

  function getWishes() {
    return wishInputs().map((i) => i.value.trim()).filter(Boolean);
  }

  function updateSign() {
    $("#signName").textContent = nameEl.value.trim() || "…";
  }

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        name: nameEl.value, age: ageEl.value, city: cityEl.value, about: aboutEl.value,
        wishes: wishInputs().map((i) => i.value),
        good: goodEl.checked
      }));
    } catch (e) { /* private mode */ }
  }

  function loadDraft() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (e) { /* ignore */ }
    wishesEl.innerHTML = "";
    nameEl.value = urlName || (d && d.name) || "";
    ageEl.value = (d && d.age) || "";
    cityEl.value = (d && d.city) || "";
    aboutEl.value = (d && d.about) || "";
    applyLocks();
    goodEl.checked = !!(d && d.good);
    const wishes = d && Array.isArray(d.wishes) && d.wishes.length ? d.wishes.slice(0, MAX_WISHES) : ["", "", ""];
    wishes.forEach((w) => addWish(w, false));
    updateSign();
  }

  form.addEventListener("input", (e) => {
    const field = e.target.closest("[data-field]");
    if (field) clearFail(field);
    if (e.target === nameEl) updateSign();
    errorEl.textContent = "";
    saveDraft();
  });
  goodEl.addEventListener("change", () => {
    clearFail(goodEl.closest(".check"));
    errorEl.textContent = "";
    saveDraft();
  });

  // The message is shown right under the field it is about
  function fail(fieldName, message, focusEl) {
    const field = form.querySelector(`[data-field="${fieldName}"]`);
    field.classList.add("invalid");
    field.classList.remove("shake");
    void field.offsetWidth;
    field.classList.add("shake");
    let msg = msgOf(field);
    if (!msg) {
      msg = document.createElement("p");
      msg.className = "field-msg";
      msg.id = `msg-${fieldName}`;
      msg.setAttribute("role", "alert");
      anchorOf(field).after(msg);
    }
    msg.textContent = message;
    const input = focusEl || field.querySelector("input");
    if (input) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", msg.id);
    }
    if (focusEl) focusEl.focus({ preventScroll: true });
    field.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    return false;
  }

  // Age and city share a row: their message goes under the row
  const anchorOf = (field) => (field.parentElement.classList.contains("field-row") ? field.parentElement : field);
  const msgOf = (field) => {
    const el = anchorOf(field).nextElementSibling;
    return el && el.id === `msg-${field.dataset.field}` ? el : null;
  };

  function clearFail(field) {
    field.classList.remove("invalid");
    const msg = msgOf(field);
    if (msg) msg.remove();
    field.querySelectorAll("[aria-invalid]").forEach((el) => {
      el.removeAttribute("aria-invalid");
      el.removeAttribute("aria-describedby");
    });
  }

  function applyLocks() {
    [[ageEl, locked.age], [cityEl, locked.city]].forEach(([el, value]) => {
      if (!value) return;
      el.value = value;
      el.readOnly = true;
      el.classList.add("locked");
      el.title = "Це вписали батьки";
    });
  }

  function validate() {
    form.querySelectorAll("[data-field]").forEach(clearFail);
    if (!nameEl.value.replace(/\p{Cf}/gu, "").trim()) return fail("name", "Напиши, будь ласка, своє ім'я 🙂", nameEl);
    const age = +ageEl.value.trim();
    if (!(age >= 1 && age <= 99)) return fail("age", "Напиши, скільки тобі років 🎂", ageEl);
    if (!cityEl.value.trim()) return fail("city", "Напиши, у якому місті чи селі ти живеш 🏠", cityEl);
    if (!getWishes().length) return fail("wishes", "Додай хоча б одне бажання 🎁", wishesEl.querySelector(".wish-text"));
    if (!goodEl.checked) return fail("good", "Підтверди, що ти був чемним / була чемною 😇");
    return true;
  }

  /* ================= Sending ================= */
  async function sendLetter(data) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch("api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ l: linkToken, good: true }, data)),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        const err = new Error(json.error || `HTTP ${res.status}`);
        err.rate = res.status === 429;
        err.limit = json.error === "limit";
        err.used = json.error === "used";
        err.link = json.error === "link";
        err.busy = json.error === "busy";
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sendBtn.disabled || !validate()) return;

    const data = { name: nameEl.value.trim(), age: ageEl.value.trim(), city: cityEl.value.trim(), about: aboutEl.value.trim(), wishes: getWishes() };
    sendBtn.disabled = true;
    sendBtn.innerHTML = 'Надсилаю… <span class="spin">❄</span>';
    errorEl.textContent = "";

    try {
      // honeypot: bots tick hidden checkbox — pretend success, send nothing
      if (!$("#botcheck").checked) await sendLetter(data);
      try { localStorage.removeItem(DRAFT_KEY); } catch (err) { /* ignore */ }
      showSent(data.name);
    } catch (err) {
      console.error(err);
      if (err.used) return showUsed(urlName || data.name);
      errorEl.textContent = err.link
        ? BAD_LINK
        : err.busy
        ? "Сьогодні пошта Святого Миколая переповнена 📮 Спробуй завтра."
        : err.limit
        ? "Сьогодні Святий Миколай уже отримав багато листів із вашої родини! 📚 Спробуй завтра."
        : err.rate
        ? "До Святого Миколая зараз летить дуже багато листів 😊 Спробуй ще раз за кілька хвилин."
        : "Ой, сніжна буря завадила надіслати лист 🌨️ Спробуй ще раз.";
      sendBtn.disabled = false;
      sendBtn.textContent = "Надіслати листа ✉️";
    }
  });

  function showSent(name) {
    const wrap = $("#paperWrap");
    wrap.classList.add("flying");
    setTimeout(() => {
      letterScreen.hidden = true;
      wrap.classList.remove("flying");
      $("#sentName").textContent = name;
      $("#againBtn").hidden = !!linkToken; // a personal link sends only one letter
      sent.hidden = false;
      window.scrollTo(0, 0);
      if (window.Sky) window.Sky.burst(window.innerWidth / 2, window.innerHeight * 0.28, 70);
      sendBtn.disabled = false;
      sendBtn.textContent = "Надіслати листа ✉️";
    }, reduceMotion ? 50 : 1250);
  }

  $("#againBtn").addEventListener("click", () => {
    loadDraft();
    sent.hidden = true;
    letterScreen.hidden = false;
    growAll();
    window.scrollTo(0, 0);
  });

  // This personal link has already sent its letter: nothing more to write
  function showUsed(name) {
    linkUsed = true;
    try { localStorage.removeItem(DRAFT_KEY); } catch (err) { /* ignore */ }
    intro.hidden = true;
    letterScreen.hidden = true;
    sent.querySelector(".title").textContent = "Лист уже в Миколая!";
    const sub = sent.querySelector(".subtitle");
    sub.textContent = "";
    const b = document.createElement("b");
    b.textContent = name || "";
    sub.append("Святий Миколай уже отримав твого листа", ...(name ? [", ", b] : []), ". Залишайся чемною дитиною і далі! ⭐");
    $("#againBtn").hidden = true;
    sent.hidden = false;
    window.scrollTo(0, 0);
  }

  function personalize(name) {
    urlName = name;
    if (!nameEl.value.trim() || letterScreen.hidden) nameEl.value = name;
    const sub = intro.querySelector(".subtitle");
    sub.textContent = "";
    const b = document.createElement("b");
    b.textContent = name;
    sub.append("Привіт, ", b, "! ✨", document.createElement("br"), "Святий Миколай чекає саме на твій лист!");
    document.title = `Лист Святому Миколаю — ${name}`;
    updateSign();
  }

  const BAD_LINK = "Ой! Це посилання вже не діє 😔 Попроси маму чи тата зробити нове.";
  // Unknown or expired personal link: the letter could not reach the parents
  function showBadLink() {
    intro.querySelector(".subtitle").textContent = BAD_LINK;
    $("#openBtn").hidden = true;
    intro.querySelector(".hint").hidden = true;
    errorEl.textContent = BAD_LINK; // in case the letter is already open
  }

  loadDraft();

  if (linkToken) {
    fetch(`api/open?l=${encodeURIComponent(linkToken)}`)
      .then((res) => (res.status === 400 ? (showBadLink(), null) : res.ok ? res.json() : null))
      .then((json) => {
        if (!json) return;
        if (json.used) return showUsed(json.name);
        locked.age = json.age || "";
        locked.city = json.city || "";
        applyLocks();
        if (json.name) personalize(json.name);
      })
      .catch(() => { /* the letter still works without personalization */ });
  }
})();
