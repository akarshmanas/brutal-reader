(() => {
  if (window.__brutalReaderLoaded) return;
  window.__brutalReaderLoaded = true;

  let overlay = null;

  // ─────────────────────────────────────────────────────────────────────────
  // ROOT DETECTION
  // ─────────────────────────────────────────────────────────────────────────

  function isTwitter() {
    return /twitter\.com|x\.com/.test(location.hostname);
  }

  function isSubstack() {
    return /substack\.com/.test(location.hostname) ||
           !!document.querySelector('.substack-post-content, .post-content.available');
  }

  function findArticleRoot() {
    // ── Substack ────────────────────────────────────────────────────────────
    if (isSubstack()) {
      const tries = [
        '.available-content .body',
        '.post-content',
        '.substack-post-content',
        '.body.markup',
        'article .available-content',
        'article',
      ];
      for (const sel of tries) {
        const el = document.querySelector(sel);
        if (el && (el.innerText || '').trim().length > 200) return el;
      }
    }

    // ── Twitter/X ────────────────────────────────────────────────────────────
    if (isTwitter()) {
      const tries = [
        '[data-testid="articleContent"]',
        '[data-testid="primaryColumn"]',
        'main[role="main"]',
        'main',
      ];
      for (const sel of tries) {
        const el = document.querySelector(sel);
        if (el && (el.innerText || '').trim().length > 100) return el;
      }
    }

    // ── Generic semantic selectors ───────────────────────────────────────────
    const semantic = [
      'article', '[role="article"]', 'main', '[role="main"]',
      '.post-content', '.article-body', '.entry-content', '.article-content',
      '.article__body', '.story-body', '.body-copy', '.prose',
      '#article-body', '#content',
    ];
    for (const sel of semantic) {
      try {
        const el = document.querySelector(sel);
        if (el && (el.innerText || '').trim().length > 300) return el;
      } catch(e) {}
    }

    // ── Fallback: score by text density ─────────────────────────────────────
    let best = null, bestScore = -Infinity;
    document.querySelectorAll('div, section').forEach(el => {
      const text = (el.innerText || '').length;
      if (text < 300) return;
      const links = Array.from(el.querySelectorAll('a'))
        .reduce((s, a) => s + (a.innerText || '').length, 0);
      const score = text * (1 - (links / text)) - el.querySelectorAll('*').length * 0.5;
      if (score > bestScore) { bestScore = score; best = el; }
    });
    return best;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BLOCK EXTRACTION — walk text nodes directly, no DOM cloning
  // ─────────────────────────────────────────────────────────────────────────

  const SKIP_TAGS = new Set([
    'script','style','noscript','iframe','form','nav','aside',
    'footer','header','button','svg','input','select','textarea',
  ]);

  const SKIP_ROLES = new Set([
    'button','navigation','toolbar','menubar','complementary',
    'banner','contentinfo','dialog','alertdialog'
  ]);

  // Tightly scoped — only clear UI chrome, not content wrappers
  const SKIP_PATTERN = /\b(advertisement|social-share|share-buttons|comment-section|related-posts|newsletter-signup|subscribe-widget|paywall|cookie-banner|site-nav|site-footer|sidebar-widget|like-button|retweet-btn|reply-btn|follow-btn|engagement-bar|analytics-bar)\b/i;

  // Substack-specific junk containers to skip entirely
  const SUBSTACK_JUNK = new Set([
    'subscription-widget', 'subscribe-widget', 'paywall',
    'post-footer', 'comments-section', 'share-dialog',
    'button-wrapper', 'post-ufi', // ufi = user facing interactions
  ]);

  function shouldSkip(el) {
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) return true;
    const role = el.getAttribute('role') || '';
    if (SKIP_ROLES.has(role)) return true;
    const testid = el.getAttribute('data-testid') || '';
    // Twitter UI elements identified by data-testid
    if (/^(like|retweet|reply|follow|share|bookmark|caret|more|analytics|tweet-stats)/i.test(testid)) return true;
    const label = `${el.className || ''} ${el.id || ''} ${testid}`;
    if (SKIP_PATTERN.test(label)) return true;
    // Substack-specific junk
    for (const junk of SUBSTACK_JUNK) {
      if (label.toLowerCase().includes(junk)) return true;
    }
    return false;
  }

  function extractBlocks(root) {
    const blocks = [];
    let paraTokens = [];

    function flushPara() {
      const text = paraTokens.join(' ').replace(/\s+/g, ' ').trim();
      if (text.length > 40) blocks.push({ type: 'p', text });
      paraTokens = [];
    }

    function walk(node) {
      // Text node — accumulate into current paragraph
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t) paraTokens.push(t);
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (shouldSkip(node)) return;

      const tag = node.tagName.toLowerCase();

      // Images — check rendered size against live DOM (not clone)
      if (tag === 'img') {
        const src = node.getAttribute('src') || node.getAttribute('data-src') ||
                    node.getAttribute('data-lazy-src') || node.getAttribute('data-original') || '';
        if (src) {
          const rect = node.getBoundingClientRect();
          const w = rect.width || node.naturalWidth || parseInt(node.getAttribute('width') || '0');
          if (w >= 150) {
            flushPara();
            blocks.push({ type: 'img', src, alt: node.getAttribute('alt') || '' });
          }
        }
        return;
      }

      // Headings
      if (/^h[1-6]$/.test(tag)) {
        flushPara();
        const text = (node.innerText || '').trim();
        if (text) blocks.push({ type: 'h', level: parseInt(tag[1]), text });
        return;
      }

      // Blockquote
      if (tag === 'blockquote') {
        flushPara();
        const text = (node.innerText || '').trim();
        if (text) blocks.push({ type: 'blockquote', text });
        return;
      }

      // List items
      if (tag === 'li') {
        flushPara();
        const text = (node.innerText || '').trim();
        if (text) blocks.push({ type: 'li', text });
        return;
      }

      // Block-level containers — flush before descending, flush after
      const isBlock = ['p','div','section','article','main','figure',
                       'ul','ol','br','hr','table','tr','td','th'].includes(tag);

      if (isBlock || tag === 'p') flushPara();
      for (const child of node.childNodes) walk(child);
      if (isBlock || tag === 'p') flushPara();
    }

    walk(root);
    flushPara();

    // Merge consecutive li → ul
    const merged = [];
    for (const b of blocks) {
      if (b.type === 'li' && merged.length && merged[merged.length - 1].type === 'ul') {
        merged[merged.length - 1].items.push(b.text);
      } else if (b.type === 'li') {
        merged.push({ type: 'ul', items: [b.text] });
      } else {
        merged.push(b);
      }
    }

    // Deduplicate consecutive identical paragraphs (Twitter repeats some nodes)
    const deduped = [];
    for (const b of merged) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.type === b.type && prev.text === b.text) continue;
      deduped.push(b);
    }

    return deduped;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER BLOCKS → HTML
  // ─────────────────────────────────────────────────────────────────────────

  function esc(t) {
    return (t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function renderBlocks(blocks) {
    return blocks.map(b => {
      switch (b.type) {
        case 'p':
          return `<p>${esc(b.text)}</p>`;
        case 'h':
          const tag = b.level <= 2 ? 'h2' : 'h3';
          return `<${tag}>${esc(b.text)}</${tag}>`;
        case 'blockquote':
          return `<blockquote>${esc(b.text)}</blockquote>`;
        case 'ul':
          return `<ul>${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
        case 'img':
          return `<figure><img src="${esc(b.src)}" alt="${esc(b.alt)}" loading="lazy"></figure>`;
        default:
          return '';
      }
    }).join('\n');
  }

  function readTime(blocks) {
    const words = blocks
      .filter(b => b.text || b.items)
      .reduce((s, b) => {
        const t = b.text || (b.items || []).join(' ');
        return s + t.split(/\s+/).length;
      }, 0);
    return { words, mins: Math.max(1, Math.ceil(words / 238)) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OVERLAY
  // ─────────────────────────────────────────────────────────────────────────

  function buildOverlay(blocks) {
    const { words, mins } = readTime(blocks);
    const html = renderBlocks(blocks);

    const div = document.createElement('div');
    div.id = '__brutal_reader__';
    div.innerHTML = `
      <div class="br-wrap">
        <div class="br-topbar">
          <span class="br-logo">BRUTAL READER</span>
          <div class="br-meta">
            <span class="br-stat">${words.toLocaleString()} words</span>
            <span class="br-dot">·</span>
            <span class="br-stat">${mins} min read</span>
          </div>
          <button class="br-close" id="br-close-btn">✕ Exit</button>
        </div>
        <div class="br-progress-bar"><div class="br-progress-fill" id="br-progress"></div></div>
        <div class="br-content">
          <h1 class="br-title">${esc(document.title)}</h1>
          <div class="br-article">${html || '<p class="br-empty">Could not extract article content.</p>'}</div>
        </div>
      </div>`;

    const style = document.createElement('style');
    style.id = '__brutal_reader_styles__';
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap');

      #__brutal_reader__ {
        all: initial;
        display: block;
        position: fixed !important;
        top: 0 !important; left: 0 !important;
        width: 100vw !important; height: 100vh !important;
        z-index: 2147483647 !important;
        background-color: #f0e6d0;
        background-image:
          url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Cfilter id='p'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3CfeBlend in='SourceGraphic' mode='multiply'/%3E%3C/filter%3E%3Crect width='400' height='400' filter='url(%23p)' opacity='0.09'/%3E%3C/svg%3E"),
          url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='turbulence' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23g)' opacity='0.05'/%3E%3C/svg%3E");
        background-repeat: repeat;
        overflow-y: auto !important;
        overflow-x: hidden;
        font-family: 'Lora', Georgia, serif;
        color: #1a1a1a;
        scroll-behavior: smooth;
        isolation: isolate;
      }

      #__brutal_reader__ *, #__brutal_reader__ *::before, #__brutal_reader__ *::after {
        box-sizing: border-box;
      }

      #__brutal_reader__ .br-topbar {
        position: sticky; top: 0; z-index: 10;
        display: flex; align-items: center; gap: 16px;
        padding: 14px 32px;
        background: #1a1a1a; color: #f5f0e8;
      }

      #__brutal_reader__ .br-logo {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; font-weight: 500;
        letter-spacing: 0.2em; opacity: 0.9; flex-shrink: 0;
      }

      #__brutal_reader__ .br-meta {
        display: flex; align-items: center; gap: 8px; margin-left: auto;
      }

      #__brutal_reader__ .br-stat {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; opacity: 0.6; letter-spacing: 0.05em;
      }

      #__brutal_reader__ .br-dot { opacity: 0.3; font-size: 11px; }

      #__brutal_reader__ .br-close {
        all: unset;
        display: inline-block;
        border: 1px solid rgba(245,240,232,0.3);
        color: #f5f0e8;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; letter-spacing: 0.1em;
        padding: 6px 14px; cursor: pointer;
        border-radius: 2px;
        transition: background 0.15s, border-color 0.15s;
        flex-shrink: 0;
      }

      #__brutal_reader__ .br-close:hover {
        background: rgba(245,240,232,0.15);
        border-color: rgba(245,240,232,0.6);
      }

      #__brutal_reader__ .br-progress-bar {
        height: 2px; background: rgba(26,26,26,0.08);
        position: sticky; top: 49px; z-index: 9;
      }

      #__brutal_reader__ .br-progress-fill {
        height: 100%; background: #c8502a;
        width: 0%; transition: width 0.1s linear;
      }

      #__brutal_reader__ .br-content {
        max-width: 680px; margin: 0 auto;
        padding: 64px 32px 128px;
      }

      #__brutal_reader__ .br-title {
        font-family: 'Lora', Georgia, serif;
        font-size: clamp(26px, 4vw, 40px); font-weight: 600;
        line-height: 1.2; margin: 0 0 48px; color: #1a1a1a;
        letter-spacing: -0.01em;
        border-bottom: 2px solid #1a1a1a; padding-bottom: 32px;
      }

      #__brutal_reader__ .br-article p {
        font-size: 19px; line-height: 1.85;
        margin: 0 0 1.5em; color: #2a2a2a;
      }

      #__brutal_reader__ .br-article h2 {
        font-family: 'Lora', Georgia, serif;
        font-size: 24px; font-weight: 600;
        margin: 2.2em 0 0.6em; color: #1a1a1a; line-height: 1.25;
      }

      #__brutal_reader__ .br-article h3 {
        font-family: 'Lora', Georgia, serif;
        font-size: 20px; font-weight: 600;
        margin: 2em 0 0.5em; color: #1a1a1a;
      }

      #__brutal_reader__ .br-article blockquote {
        border-left: 3px solid #c8502a;
        margin: 2em 0; padding: 0.4em 0 0.4em 1.5em;
        font-style: italic; color: #444;
        font-size: 20px; line-height: 1.7;
      }

      #__brutal_reader__ .br-article figure { margin: 2em 0; }

      #__brutal_reader__ .br-article img {
        max-width: 100%; height: auto;
        display: block; border-radius: 2px;
      }

      #__brutal_reader__ .br-article ul,
      #__brutal_reader__ .br-article ol {
        font-size: 19px; line-height: 1.8;
        margin: 0 0 1.5em; padding-left: 1.5em; color: #2a2a2a;
      }

      #__brutal_reader__ .br-article li { margin-bottom: 0.4em; }

      #__brutal_reader__ .br-empty {
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px; color: #999;
        text-align: center; margin-top: 80px; letter-spacing: 0.05em;
      }

      @media (max-width: 600px) {
        #__brutal_reader__ .br-content  { padding: 40px 20px 80px; }
        #__brutal_reader__ .br-topbar   { padding: 12px 16px; gap: 10px; }
        #__brutal_reader__ .br-article p { font-size: 17px; }
        #__brutal_reader__ .br-logo     { display: none; }
      }
    `;

    document.head.appendChild(style);
    document.documentElement.appendChild(div);

    div.querySelector('#br-close-btn').addEventListener('click', deactivate);
    document.addEventListener('keydown', handleKey);

    div.addEventListener('scroll', () => {
      const pct = div.scrollTop / (div.scrollHeight - div.clientHeight);
      const fill = div.querySelector('#br-progress');
      if (fill) fill.style.width = Math.min(pct * 100, 100) + '%';
    });

    return div;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ACTIVATE / DEACTIVATE / TOGGLE
  // ─────────────────────────────────────────────────────────────────────────

  function activate() {
    if (overlay) return;
    const root = findArticleRoot();
    const blocks = root ? extractBlocks(root) : [];
    overlay = buildOverlay(blocks);
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }

  function deactivate() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    const s = document.getElementById('__brutal_reader_styles__');
    if (s) s.remove();
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    document.removeEventListener('keydown', handleKey);
  }

  function handleKey(e) { if (e.key === 'Escape') deactivate(); }
  function toggle() { overlay ? deactivate() : activate(); }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'toggle') toggle();
  });
})();
