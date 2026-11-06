# arpangpta.github.io

Personal portfolio of Arpan Gupta, AI Product Engineer. Live at https://arpangpta.github.io/

- Plain HTML, CSS and JavaScript: no build step, so GitHub Pages serves it as is.
- `js/scene.js`: the Three.js hero, an "embedding space" of clustered nodes with signal pulses travelling along the network.
- `js/main.js`: navigation, scroll progress, reveal-on-scroll, typed headline, count-up metrics, RAG pipeline animation and card tilt.
- Respects `prefers-reduced-motion`, pauses the 3D scene when it is off screen, and falls back to a gradient when WebGL is unavailable.

Run locally: `python3 -m http.server 8000`, then open http://localhost:8000
