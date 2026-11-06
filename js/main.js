// Page interactions: nav, scroll progress, reveal-on-scroll, typed text,
// count-up metrics, the RAG pipeline highlight and card tilt.
(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  document.documentElement.classList.remove("no-js");
  document.getElementById("year").textContent = new Date().getFullYear();

  /* Nav background + scroll progress bar */
  const nav = document.getElementById("nav");
  const progress = document.querySelector(".scroll-progress");
  const onScroll = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
    nav.classList.toggle("is-scrolled", window.scrollY > 40);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* Mobile menu */
  const toggle = document.querySelector(".nav__toggle");
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
    document.body.style.overflow = open ? "hidden" : "";
  });
  document.querySelectorAll(".nav__links a").forEach((a) =>
    a.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
      document.body.style.overflow = "";
    })
  );

  /* Highlight the nav link of the section in view */
  const links = [...document.querySelectorAll(".nav__links a[href^='#']")];
  const sectionObserver = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (!e.isIntersecting) return;
      links.forEach((l) => l.classList.toggle("is-active", l.getAttribute("href") === `#${e.target.id}`));
    }),
    { rootMargin: "-45% 0px -50% 0px" }
  );
  document.querySelectorAll("section[id]").forEach((s) => sectionObserver.observe(s));

  /* Reveal on scroll, with a small stagger for siblings */
  const reveals = document.querySelectorAll(".reveal");
  reveals.forEach((el) => {
    const siblings = [...el.parentElement.children].filter((c) => c.classList.contains("reveal"));
    el.style.setProperty("--delay", `${Math.min(siblings.indexOf(el), 5) * 0.08}s`);
  });
  const revealObserver = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("is-visible"); revealObserver.unobserve(e.target); }
    }),
    { threshold: 0.12 }
  );
  reveals.forEach((el) => revealObserver.observe(el));

  /* Typed hero line */
  const typed = document.getElementById("typed");
  const phrases = [
    "production RAG systems",
    "multi-agent workflows",
    "LLM evals that move the numbers",
    "agents with guardrails",
    "AI products, zero to production",
  ];
  if (!reduceMotion) {
    let p = 0, i = phrases[0].length, deleting = true;
    const tick = () => {
      const word = phrases[p];
      i += deleting ? -1 : 1;
      typed.textContent = word.slice(0, i);
      let delay = deleting ? 32 : 60;
      if (!deleting && i === word.length) { deleting = true; delay = 2200; }
      else if (deleting && i === 0) { deleting = false; p = (p + 1) % phrases.length; delay = 350; }
      setTimeout(tick, delay);
    };
    setTimeout(tick, 2600);
  }

  /* Count-up metrics */
  const countObserver = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (!e.isIntersecting) return;
      countObserver.unobserve(e.target);
      const el = e.target;
      const to = parseFloat(el.dataset.to);
      const decimals = parseInt(el.dataset.decimals || "0", 10);
      if (reduceMotion || to === 0) { el.textContent = to.toFixed(decimals); return; }
      const start = performance.now(), dur = 1600;
      const step = (now) => {
        const t = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = (to * eased).toFixed(decimals);
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }),
    { threshold: 0.6 }
  );
  document.querySelectorAll(".count").forEach((el) => countObserver.observe(el));

  /* RAG pipeline: light up one stage after another */
  const stages = [...document.querySelectorAll(".stage")];
  if (stages.length) {
    let s = 0;
    stages[0].classList.add("is-active");
    if (!reduceMotion) {
      setInterval(() => {
        stages[s].classList.remove("is-active");
        s = (s + 1) % stages.length;
        stages[s].classList.add("is-active");
      }, 800);
    }
  }

  /* Card tilt + cursor spotlight (mouse only) */
  if (finePointer && !reduceMotion) {
    document.querySelectorAll(".tilt").forEach((card) => {
      card.addEventListener("mousemove", (e) => {
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        card.style.setProperty("--mx", `${x * 100}%`);
        card.style.setProperty("--my", `${y * 100}%`);
        card.style.transform = `perspective(900px) rotateX(${(0.5 - y) * 5}deg) rotateY(${(x - 0.5) * 6}deg) translateY(-3px)`;
      });
      card.addEventListener("mouseleave", () => { card.style.transform = ""; });
    });
  }
})();
