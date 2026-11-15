// Página de download do Athenas Agent: idioma, vídeo, temas, release e pequenos detalhes vivos.
(function () {
  'use strict';

  var REPO = 'victxrcb/Athenas';
  var RELEASES = 'https://github.com/' + REPO + '/releases/latest';
  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var store = {
    get: function (key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set: function (key, value) { try { localStorage.setItem(key, value); } catch (e) { /* armazenamento indisponível */ } },
  };

  // ---------- Textos ----------
  var EN = {
    'meta.title': 'Athenas Agent — your AI agents in a single panel',
    'meta.description': 'Open source desktop app to manage AI agents: Claude Code, Codex and real terminals organized into projects, with orchestration, Git, MCP and Skills.',
    skip: 'Skip to content',
    'nav.video': 'Video', 'nav.features': 'Features', 'nav.orchestration': 'Orchestration', 'nav.customize': 'Customization', 'nav.download': 'Download',
    'hero.kicker': 'Open source · Windows · Local-first',
    'hero.title': 'Your AI agents<br><span class="accent">in a single panel.</span>',
    'hero.lead': 'Claude Code, Codex and real terminals organized into projects. Orchestrate workers, review diffs and make it all yours — no account, no cloud.',
    'cta.windows': 'Download for Windows', 'cta.watch': 'Watch the video',
    'hero.free': 'free', 'hero.source': 'source on GitHub',
    'status.running': 'running', 'status.waiting': 'waiting for you', 'status.done': 'done',
    'alt.hero': 'A project with four agents working side by side in Athenas Agent',
    'video.kicker': 'overview', 'video.title': 'See Athenas in 90 seconds', 'video.lead': 'A tour of the features and the ways to customize the app.', 'video.subtitles': 'Subtitles',
    'features.kicker': 'features', 'features.title': 'Everything you need to manage agents', 'features.lead': 'A native Windows app that brings sessions, projects and tools together.',
    'f1.title': 'Command center', 'f1.text': 'See every running agent, your recent projects and what needs your attention. Describe the task, pick the agent and go.',
    'f1.b1': 'Claude Code, Codex or Shell in any folder', 'f1.b2': 'Normal, Plan and Auto-accept modes', 'f1.b3': 'Sessions you can resume after closing the app',
    'f2.title': 'Real terminals, side by side', 'f2.text': 'Each agent runs in a real PTY. Organize by groups and projects and choose how the screen is split.',
    'f2.b1': 'Auto, Focus, Side and Grid layouts', 'f2.b2': 'Sub-tabs, pinned panes and drag between panes', 'f2.b3': 'Hiding a view never kills the process',
    'f3.title': 'Visual mapping', 'f3.text': 'A canvas with every agent at once. Move, resize and connect agents to decide who commands whom.',
    'f3.b1': 'Terminal mode and architecture mode', 'f3.b2': 'Zoom, minimap and auto-arrange',
    'f4.title': 'Built-in Git', 'f4.text': 'Track what your agents changed without leaving the app: status, stage, commit, side-by-side diff, branches, worktrees and pull requests.',
    'f4.b1': 'GitHub, Azure DevOps, GitLab and Bitbucket', 'f4.b2': 'Open pull requests straight from a branch',
    'f5.title': 'MCP and Skills', 'f5.text': 'Edit the MCP configuration of Claude Code and Codex with validation and automatic backups, and browse every installed Skill.',
    'f5.b1': 'User and project configuration', 'f5.b2': 'Atomic writes with a safety copy',
    'f6.title': 'Usage, memory and shortcuts', 'f6.text': 'Track each agent’s 5-hour and weekly quota, memory per group, and find anything with the command palette.',
    'f6.b1': 'Suspend whole groups to free RAM', 'f6.b2': 'Ctrl+P, Ctrl+T, Ctrl+B and more',
    'orch.kicker': 'orchestration', 'orch.title': 'One lead. Many workers. You in control.', 'orch.lead': 'A lead agent delegates tasks through Athenas’ own MCP server. Each worker runs isolated and the lead only receives the results.',
    'orch.s1.title': 'Delegate', 'orch.s1.text': 'Describe the task or let the lead call <code>hera_delegate</code>.',
    'orch.s2.title': 'Isolate', 'orch.s2.text': 'Each worker runs on its own branch and worktree, up to 3 in parallel.',
    'orch.s3.title': 'Approve', 'orch.s3.text': 'Sensitive permissions pause the worker until you approve or deny.',
    'orch.s4.title': 'Land', 'orch.s4.text': 'Review the diff and merge safely, never with force.',
    'custom.kicker': 'customization', 'custom.title': 'Make it yours.', 'custom.lead': '13 color themes, dark and light. Click one to watch the app — and this page — change color.', 'custom.themes': 'Themes',
    'custom.mascot.title': 'Claude mascot', 'custom.mascot.text': 'Color, eyes, antennas, blush and themed outfits.',
    'custom.ui.title': 'A tailored interface', 'custom.ui.b1': 'Interface font, including your installed fonts', 'custom.ui.b2': 'Zoom from 80% to 150%', 'custom.ui.b3': 'Visible shortcuts and a collapsible sidebar', 'custom.ui.b4': 'Per-project icons and an optional ASCII background',
    'dl.title': 'Download Athenas Agent', 'dl.lead': 'Free and open source. The app updates itself when a new version ships.',
    'dl.exe': 'Windows · installer', 'dl.msi': 'MSI package', 'dl.all': 'all releases', 'dl.req': 'Requirements',
    'dl.r1': 'Windows 10 or 11 (64-bit)', 'dl.r2': 'Microsoft Edge WebView2 (built into Windows 11)', 'dl.r3': '<b>Claude Code</b> and/or <b>Codex</b> CLI installed',
    'dl.smartscreen': 'The installer is not code-signed yet, so Windows SmartScreen may warn on first run. Click “More info” → “Run anyway”.',
    'cta.mac': 'Download for macOS', 'cta.linux': 'Download for Linux', 'dl.os': 'Operating system',
    'dl.dmg': 'macOS · Intel and Apple Silicon', 'dl.appimage': 'Linux · AppImage', 'dl.deb': 'Debian/Ubuntu package',
    'dl.mac.r1': 'macOS 11 Big Sur or later (Intel or Apple Silicon)', 'dl.mac.r2': '<b>Claude Code</b> and/or <b>Codex</b> CLI installed', 'dl.mac.r3': 'Agent notifications are Windows-only for now',
    'dl.linux.r1': 'Ubuntu 22.04+, Debian 12+ or an equivalent distro (64-bit)', 'dl.linux.r2': 'WebKitGTK 4.1 (included in recent distros)', 'dl.linux.r3': '<b>Claude Code</b> and/or <b>Codex</b> CLI installed', 'dl.linux.r4': 'Agent notifications are Windows-only for now',
    'dl.gatekeeper': 'The app is not signed by Apple yet, so macOS blocks the first launch. Drag it to <b>Applications</b>, try to open it, then go to <b>System Settings → Privacy &amp; Security → Open Anyway</b>. If it says the app “is damaged”, run in Terminal: <code>xattr -cr "/Applications/Athenas Agent.app"</code>',
    'dl.linuxnote': 'AppImage: make it executable with <code>chmod +x Athenas*.AppImage</code> and open it. Install the .deb with <code>sudo apt install ./file.deb</code>. Automatic updates work with the AppImage; for the .deb, download new versions here.',
    'footer.tagline': 'Made for ideas that deserve room.', 'footer.local': 'Local-first · no account · no cloud',
    'alt.home': 'Home screen with running agents', 'alt.layouts': 'Terminal layout picker', 'alt.mapping': 'Mapping canvas with several agents', 'alt.git': 'Changes and diff in the built-in Git',
    'alt.mcp': 'MCP configuration editor', 'alt.usage': 'Claude Code usage quota', 'alt.orch': 'Orchestration board with workers', 'alt.diff': 'Diff of a finished worker', 'alt.theme': 'Home screen in the selected theme',
  };
  var PT = {}; // preenchido a partir do HTML original na primeira execução

  var THEMES = [
    ['preto-branco', 'Preto e Branco', 'Black & White', ['#0a0a0a', '#ededed', '#808080']],
    ['catedral', 'Catedral', 'Cathedral', ['#0b0b0d', '#8b1e2d', '#b08d4a']],
    ['ametista', 'Ametista', 'Amethyst', ['#0d0b12', '#6d3fa0', '#b59ad6']],
    ['floresta', 'Floresta', 'Forest', ['#0a0e0c', '#2f6b4f', '#a3b18a']],
    ['ambar', 'Âmbar', 'Amber', ['#100c08', '#b4561f', '#d9a441']],
    ['oceano', 'Oceano', 'Ocean', ['#090d12', '#2b6a8f', '#7fb3c8']],
    ['grafite', 'Grafite', 'Graphite', ['#0e0f11', '#5c6670', '#c2c8cf']],
    ['rose', 'Rosé', 'Rosé', ['#120b0e', '#b0456a', '#e3a6bb']],
    ['menta', 'Menta', 'Mint', ['#08100f', '#1f8a78', '#8fd6c4']],
    ['crepusculo', 'Crepúsculo', 'Dusk', ['#110b10', '#c2503f', '#e8a15c']],
    ['meia-noite', 'Meia-noite', 'Midnight', ['#080a14', '#3d4fc2', '#9aa7f0']],
    ['pergaminho', 'Pergaminho', 'Parchment', ['#f3ede0', '#8b1e2d', '#8a6a2b']],
    ['nevoa', 'Névoa', 'Mist', ['#eef1f5', '#2f5fa8', '#6b7f99']],
  ];
  var OUTFITS = [['none', 'Clássico', 'Classic'], ['beach', 'Praia', 'Beach'], ['halloween', 'Halloween', 'Halloween'], ['christmas', 'Natal', 'Christmas'],
    ['party', 'Festa', 'Party'], ['formal', 'Formal', 'Formal'], ['pirate', 'Pirata', 'Pirate'], ['winter', 'Inverno', 'Winter']];

  var lang = root.lang === 'en' ? 'en' : 'pt';
  var release = null;

  function capturePortuguese() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) { PT[el.dataset.i18n] = el.textContent; });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) { PT[el.dataset.i18nHtml] = el.innerHTML; });
    document.querySelectorAll('[data-i18n-alt]').forEach(function (el) { PT[el.dataset.i18nAlt] = el.alt; });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) { PT[el.dataset.i18nAria] = el.getAttribute('aria-label'); });
    PT['meta.title'] = document.title;
    PT['meta.description'] = document.querySelector('meta[name="description"]').content;
  }

  function t(key) { return (lang === 'en' ? EN : PT)[key] || PT[key] || ''; }

  function applyLang(next) {
    lang = next;
    root.lang = lang === 'en' ? 'en' : 'pt-BR';
    document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-alt]').forEach(function (el) { el.alt = t(el.dataset.i18nAlt); });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    document.title = t('meta.title');
    document.querySelector('meta[name="description"]').content = t('meta.description');
    document.querySelectorAll('[data-lang]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.lang === lang)); });
    document.querySelectorAll('[data-theme-name]').forEach(function (el) { el.textContent = themeLabel(el.dataset.themeName); });
    document.querySelectorAll('[data-outfit]').forEach(function (el) { el.textContent = outfitLabel(el.dataset.outfit); });
    renderRelease();
    syncThumbs();
  }

  /** Troca de idioma pelo botão: o indicador desliza na hora e os textos esmaecem e voltam já traduzidos. */
  function switchLang(next) {
    if (next === lang) return;
    document.querySelectorAll('[data-lang]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.lang === next)); });
    syncThumbs();
    store.set('athenas-site-lang', next);
    setVideo(next);
    if (reduceMotion) { applyLang(next); return; }
    root.classList.add('i18n-out');
    setTimeout(function () {
      applyLang(next);
      requestAnimationFrame(function () { root.classList.remove('i18n-out'); });
    }, 170);
  }

  // ---------- Controles segmentados: indicador que desliza até a opção ativa ----------
  function syncThumb(group) {
    var thumb = group.querySelector('.seg-thumb');
    var active = group.querySelector('button[aria-pressed="true"]');
    if (!thumb || !active) return;
    group.style.setProperty('--x', active.offsetLeft + 'px');
    group.style.setProperty('--w', active.offsetWidth + 'px');
  }
  function syncThumbs() { document.querySelectorAll('.segmented.has-thumb').forEach(syncThumb); }
  function setupThumbs() {
    document.querySelectorAll('.segmented').forEach(function (group) {
      var thumb = document.createElement('span');
      thumb.className = 'seg-thumb';
      thumb.setAttribute('aria-hidden', 'true');
      group.prepend(thumb);
      group.classList.add('has-thumb');
      syncThumb(group);
    });
    // Só anima depois da primeira medição, para não deslizar ao carregar a página.
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      document.querySelectorAll('.segmented.has-thumb').forEach(function (group) { group.classList.add('ready'); });
    }); });
    window.addEventListener('resize', syncThumbs);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncThumbs);
  }

  // ---------- Vídeo ----------
  var video = document.getElementById('promo');
  var videoCard = video && video.closest('.video-card');
  function setVideo(next, immediate) {
    if (!video) return;
    document.querySelectorAll('[data-video]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.video === next)); });
    syncThumbs();
    var src = 'assets/video/athenas-' + next + '.mp4';
    if (video.getAttribute('src') === src) return;
    var time = video.currentTime;
    var playing = !video.paused && !video.ended;
    var swap = function () {
      video.poster = 'assets/video/poster-' + next + '.webp';
      video.src = src;
      if (time > 0) {
        video.addEventListener('loadedmetadata', function restore() {
          video.removeEventListener('loadedmetadata', restore);
          video.currentTime = Math.min(time, video.duration || time);
          if (playing) video.play().catch(function () { /* o navegador pode bloquear autoplay */ });
        });
        video.load();
      }
      if (videoCard) requestAnimationFrame(function () { videoCard.classList.remove('switching'); });
    };
    if (immediate || reduceMotion || !videoCard) { swap(); return; }
    videoCard.classList.add('switching');
    setTimeout(swap, 180);
  }
  if (video && videoCard) {
    video.addEventListener('play', function () { videoCard.classList.add('playing'); });
    video.addEventListener('pause', function () { videoCard.classList.remove('playing'); });
    video.addEventListener('ended', function () { videoCard.classList.remove('playing'); });
  }

  // ---------- Temas ----------
  function themeLabel(id) { var item = THEMES.find(function (x) { return x[0] === id; }); return item ? item[lang === 'en' ? 2 : 1] : id; }
  function outfitLabel(id) { var item = OUTFITS.find(function (x) { return x[0] === id; }); return item ? item[lang === 'en' ? 2 : 1] : id; }
  function themeShot(id) { return 'assets/screens/theme-home-' + id + '.webp'; }

  function setThemeState(id) {
    root.dataset.theme = id;
    document.querySelectorAll('.theme-chip').forEach(function (chip) { chip.setAttribute('aria-pressed', String(chip.dataset.theme === id)); });
    var meta = document.querySelector('meta[name="theme-color"]');
    var theme = THEMES.find(function (x) { return x[0] === id; });
    if (meta && theme) meta.content = theme[3][0];
    var shot = document.getElementById('theme-shot');
    if (shot && shot.getAttribute('src') !== themeShot(id)) shot.src = themeShot(id);
  }

  /** Aplica o tema; com `origin` (clique), revela o novo tema num círculo que cresce a partir daquele ponto. */
  function applyTheme(id, persist, origin) {
    if (persist) store.set('athenas-site-theme', id);
    if (!origin || reduceMotion || !document.startViewTransition) { setThemeState(id); return; }
    var img = new Image();
    img.src = themeShot(id);
    var decoded = img.decode ? img.decode().catch(function () {}) : Promise.resolve();
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 450); });
    Promise.race([decoded, timeout]).then(function () {
      root.style.setProperty('--vt-x', origin.x + 'px');
      root.style.setProperty('--vt-y', origin.y + 'px');
      root.dataset.vt = 'theme';
      var transition = document.startViewTransition(function () { setThemeState(id); });
      transition.finished.finally(function () { delete root.dataset.vt; });
    });
  }

  function preloadTheme(id) { var img = new Image(); img.src = themeShot(id); }

  function buildThemes() {
    var box = document.querySelector('.themes');
    if (!box) return;
    THEMES.forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'theme-chip';
      button.dataset.theme = item[0];
      var swatch = document.createElement('span');
      swatch.className = 'swatch';
      item[3].forEach(function (color) { var i = document.createElement('i'); i.style.background = color; swatch.appendChild(i); });
      var label = document.createElement('span');
      label.dataset.themeName = item[0];
      label.textContent = themeLabel(item[0]);
      button.append(swatch, label);
      button.addEventListener('pointerenter', function () { preloadTheme(item[0]); });
      button.addEventListener('click', function (event) {
        var box = button.getBoundingClientRect();
        var keyboard = event.detail === 0;
        applyTheme(item[0], true, { x: keyboard ? box.left + box.width / 2 : event.clientX, y: keyboard ? box.top + box.height / 2 : event.clientY });
      });
      box.appendChild(button);
    });
    var mascots = document.querySelector('.mascots');
    if (mascots) OUTFITS.forEach(function (item) {
      var figure = document.createElement('figure');
      var img = document.createElement('img');
      img.src = 'assets/screens/mascot-' + item[0] + '.webp';
      img.alt = '';
      img.loading = 'lazy';
      img.width = 760; img.height = 292;
      var caption = document.createElement('figcaption');
      caption.dataset.outfit = item[0];
      caption.textContent = outfitLabel(item[0]);
      figure.append(img, caption);
      mascots.appendChild(figure);
    });
  }

  // ---------- Release mais recente ----------
  function formatSize(bytes) { return (bytes / 1048576).toFixed(1).replace('.', lang === 'en' ? '.' : ',') + ' MB'; }

  // Instaladores por sistema: [classe do link, classe do tamanho, extensão exibida, padrão do arquivo].
  var PACKAGES = [
    ['download-exe', 'exe-size', '.exe', /-setup\.exe$/i],
    ['download-msi', 'msi-size', '.msi', /\.msi$/i],
    ['download-dmg', 'dmg-size', '.dmg', /\.dmg$/i],
    ['download-appimage', 'appimage-size', '.AppImage', /\.AppImage$/i],
    ['download-deb', 'deb-size', '.deb', /\.deb$/i],
  ];
  var PRIMARY = { windows: 'download-exe', mac: 'download-dmg', linux: 'download-appimage' };

  function detectOs() {
    var platform = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase();
    if (/mac|iphone|ipad/.test(platform)) return 'mac';
    if (/linux|x11|cros/.test(platform) && !/android/.test(navigator.userAgent.toLowerCase())) return 'linux';
    return 'windows';
  }
  var os = detectOs();

  /** Mostra os botões, requisitos e avisos do sistema escolhido; o botão do topo sempre segue o sistema detectado. */
  function showOs(next) {
    os = next;
    document.querySelectorAll('.download-card .os-only').forEach(function (el) { el.hidden = el.dataset.os !== next; });
    document.querySelectorAll('[data-os-pick]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.osPick === next)); });
    syncThumbs();
  }

  function heroOs() {
    var detected = detectOs();
    document.querySelectorAll('.download-hero .os-only').forEach(function (el) { el.hidden = el.dataset.os !== detected; });
    var primary = document.querySelector('.' + PRIMARY[detected]);
    document.querySelectorAll('.download-hero').forEach(function (a) { a.href = primary ? primary.href : RELEASES; });
  }

  function renderRelease() {
    if (!release) return;
    document.querySelectorAll('.release-version').forEach(function (el) { el.textContent = release.tag_name; });
    PACKAGES.forEach(function (item) {
      var asset = release.assets.find(function (a) { return item[3].test(a.name); });
      if (!asset) return;
      document.querySelectorAll('.' + item[0]).forEach(function (a) { a.href = asset.browser_download_url; });
      document.querySelectorAll('.' + item[1]).forEach(function (el) { el.textContent = item[2] + ' · ' + formatSize(asset.size); });
    });
    heroOs();
    var date = new Date(release.published_at);
    if (!isNaN(date.getTime())) {
      var label = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'pt-BR', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
      document.querySelectorAll('.release-date').forEach(function (el) { el.textContent = ' · ' + label; });
    }
  }

  function loadRelease() {
    // Sem a API (offline ou limite de requisições), os botões continuam levando à página de releases.
    if (!window.fetch) return;
    fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
      .then(function (data) { if (data && Array.isArray(data.assets)) { release = data; renderRelease(); } })
      .catch(function () {
        document.querySelectorAll('.download-hero, .download-exe, .download-msi, .download-dmg, .download-appimage, .download-deb').forEach(function (a) { a.href = RELEASES; });
      });
  }

  // ---------- Detalhes vivos ----------
  function liveCounters() {
    if (reduceMotion) return;
    var running = document.querySelector('[data-count="running"]');
    var done = document.querySelector('[data-count="done"]');
    var ram = document.querySelector('[data-count="ram"]');
    var tick = 0;
    setInterval(function () {
      if (document.hidden) return;
      tick++;
      if (running) running.textContent = String(6 - (tick % 3 === 0 ? 1 : 0));
      if (done && tick % 4 === 0) done.textContent = String(3 + ((tick / 4) % 6));
      if (ram) ram.textContent = String(206 + Math.round(Math.random() * 14));
    }, 2200);
  }

  /** Destaca na nav a seção que está na tela. */
  function trackSection() {
    var links = Array.prototype.slice.call(document.querySelectorAll('.nav-links a'));
    if (!links.length || !('IntersectionObserver' in window)) return;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle('current', a.getAttribute('href') === '#' + entry.target.id); });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    links.forEach(function (a) { var section = document.querySelector(a.getAttribute('href')); if (section) observer.observe(section); });
  }

  function reveal() {
    var items = document.querySelectorAll('.reveal');
    // Itens irmãos entram em cascata.
    items.forEach(function (el) {
      var siblings = Array.prototype.filter.call(el.parentElement.children, function (x) { return x.classList.contains('reveal'); });
      var index = siblings.indexOf(el);
      if (siblings.length > 1 && !el.classList.contains('feature')) el.style.setProperty('--delay', (index * 0.09) + 's');
    });
    if (reduceMotion || !('IntersectionObserver' in window)) { items.forEach(function (el) { el.classList.add('in'); }); return; }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { if (entry.isIntersecting) { entry.target.classList.add('in'); observer.unobserve(entry.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    items.forEach(function (el) { observer.observe(el); });
  }

  function lightbox() {
    var dialog = document.querySelector('.lightbox');
    if (!dialog || typeof dialog.showModal !== 'function') return;
    var img = dialog.querySelector('img');
    document.querySelectorAll('.shot img').forEach(function (source) {
      source.addEventListener('click', function () { img.src = source.currentSrc || source.src; img.alt = source.alt; dialog.showModal(); });
    });
    dialog.querySelector('.lightbox-close').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (event) { if (event.target === dialog) dialog.close(); });
  }

  // ---------- Início ----------
  capturePortuguese();
  buildThemes();
  applyTheme(root.dataset.theme || 'preto-branco', false);
  if (lang === 'en') applyLang('en');
  setVideo(lang, true);
  showOs(os);
  heroOs();
  setupThumbs();
  document.querySelectorAll('[data-os-pick]').forEach(function (button) {
    button.addEventListener('click', function () { showOs(button.dataset.osPick); });
  });
  document.querySelectorAll('[data-lang]').forEach(function (button) {
    button.addEventListener('click', function () { switchLang(button.dataset.lang); });
  });
  document.querySelectorAll('[data-video]').forEach(function (button) {
    button.addEventListener('click', function () { setVideo(button.dataset.video); });
  });
  loadRelease();
  liveCounters();
  reveal();
  lightbox();
  trackSection();
})();
