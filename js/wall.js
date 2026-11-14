/* =============================================================
 * 照片墙 · 主逻辑
 *  - 多行交替滚动（一行向左、一行向右，无缝循环）
 *  - 悬停放大 / 点击打开大图（图片 & 视频）
 *  - 懒加载、视频按需播放、减少动态效果适配
 * 数据来自 js/media.js（由 tools/build_media.py 生成）
 * ============================================================= */
(function () {
  'use strict';

  /* ---------------- 配置 ---------------- */
  var CFG = Object.assign({
    title: '我们的时光',
    subtitle: '',
    eyebrow: 'OUR LITTLE UNIVERSE',
    startDate: '',
    signature: '',
    rows: 5,
    speed: 26,
    hoverSlowdown: 0.14,
    gap: 18,
    hoverScale: 1.07,
    shuffleSeed: 520,
    theme: 'rose',
    bgm: '',
    tipImage: '滚轮 / 双击放大 · 拖动查看细节 · ← → 切换',
    tipVideo: '空格播放 / 暂停 · ← → 切换',
    respectReducedMotion: true
  }, window.PHOTO_WALL_CONFIG || {});

  var DATA = window.PHOTO_WALL_DATA || { photos: [], videos: [] };

  var ROW_FACTORS = [1.14, 0.86, 1.0, 0.9, 0.8, 0.96];
  var VPAD = 16;
  var MIN_CARD_H = 78;
  var MAX_CARD_H = 320;
  var VIDEO_QUOTA = 6;

  var reduced = CFG.respectReducedMotion &&
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- 元素 ---------------- */
  var els = {
    wall: document.getElementById('wall'),
    header: document.querySelector('.site-header'),
    footer: document.querySelector('.site-footer'),
    eyebrow: document.getElementById('eyebrow'),
    title: document.getElementById('siteTitle'),
    subtitle: document.getElementById('siteSubtitle'),
    days: document.getElementById('daysTogether'),
    count: document.getElementById('mediaCount'),
    hint: document.getElementById('hint'),
    signature: document.getElementById('signature'),
    lightbox: document.getElementById('lightbox'),
    stage: document.getElementById('lbStage'),
    lbZoom: document.getElementById('lbZoom'),
    counter: document.getElementById('lbCounter'),
    caption: document.getElementById('lbCaption'),
    tip: document.getElementById('lbTip'),
    btnClose: document.getElementById('lbClose'),
    btnPrev: document.getElementById('lbPrev'),
    btnNext: document.getElementById('lbNext'),
    backdrop: document.getElementById('lbBackdrop'),
    bgmBtn: document.getElementById('bgmBtn'),
    audio: document.getElementById('bgmAudio')
  };

  /* ---------------- 工具 ---------------- */
  function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function formatDate(str) {
    if (!str) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    return m ? m[1] + '.' + m[2] + '.' + m[3] : str;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, seed) {
    var rand = mulberry32(seed || 1);
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  /* ---------------- 数据 ---------------- */
  var items = [];

  function buildItems() {
    var raw = [];
    (DATA.photos || []).forEach(function (p) { raw.push(Object.assign({ type: 'photo' }, p)); });
    (DATA.videos || []).forEach(function (v) { raw.push(Object.assign({ type: 'video' }, v)); });
    items = raw.filter(function (it) { return it && it.file; });
    return items;
  }

  /* ---------------- 视频播放调度 ---------------- */
  var VM = {
    playing: new Map(),   // file -> video 元素
    visible: new Set(),   // 当前在视口里的 video 元素
    max: VIDEO_QUOTA,

    ensure: function (v) {
      if (v.dataset.loaded === '1') return;
      v.dataset.loaded = '1';
      if (v.dataset.src) {
        v.src = v.dataset.src;
        v.load();
      }
    },

    want: function (v) {
      if (!v || !v.dataset || !v.dataset.src) return;
      var file = v.dataset.src;
      var current = VM.playing.get(file);

      if (current !== v) {
        if (current) {
          // 同一个视频只播一份：如果原来那份还在屏幕上播，就别抢
          if (VM.visible.has(current)) return;
          current.pause();
          VM.playing.delete(file);
        }
        if (VM.playing.size >= VM.max) VM.evictOne();
        VM.playing.set(file, v);
      }

      VM.ensure(v);
      v.classList.add('is-ready');
      if (v.paused) {
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      }
    },

    release: function (v) {
      if (!v) return;
      var file = v.dataset && v.dataset.src;
      if (file && VM.playing.get(file) === v) {
        VM.playing.delete(file);
        v.pause();
      }
    },

    evictOne: function () {
      var it = VM.playing.entries().next();
      if (it.done) return;
      var file = it.value[0], v = it.value[1];
      VM.playing.delete(file);
      v.pause();
    },

    pauseAll: function () {
      VM.playing.forEach(function (v) { v.pause(); });
    },

    resumeVisible: function () {
      VM.visible.forEach(function (v) { VM.want(v); });
    }
  };

  /* ---------------- 状态 ---------------- */
  var state = {
    rows: [],
    offsetByRow: [],
    hoveredRow: -1,
    rafId: 0,
    lastTime: 0,
    open: false,
    index: 0,
    lastCard: null,
    lbVideo: null,
    suppressClick: false,
    hideTimer: 0,
    moving: !reduced && CFG.speed > 0
  };

  var zoom = { s: 1, x: 0, y: 0 };

  /* ---------------- 卡片 ---------------- */
  function aspectOf(item) {
    var ar = item.w && item.h ? item.w / item.h : 1.5;
    return clamp(ar, 0.68, 1.95);
  }

  function makeFallback(item) {
    var box = el('div', 'card-fallback');
    box.innerHTML =
      '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/>' +
      '<circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5-5-4 4-2-2-5 5"/></svg>' +
      '<span>' + (item.type === 'video' ? '视频未找到' : '照片未找到') + '</span>';
    return box;
  }

  function loadImage(card, img) {
    img.addEventListener('load', function () {
      img.classList.add('is-ready');
      card.classList.add('is-loaded');
    });
    img.addEventListener('error', function () {
      img.remove();
      card.appendChild(makeFallback(card.__item));
      card.classList.add('is-loaded');
    });
  }

  /* 自己控制图片何时开始下载：只加载（快要）出现在屏幕上的那些，
     这样即使有几百张照片，打开时也不会一次性全部请求。 */
  var imageObserver = null;

  function observeImage(card, img, src) {
    function assign() {
      if (img.dataset.assigned === '1') return;
      img.dataset.assigned = '1';
      img.src = src;
    }
    card.__assignImage = assign;

    if (!window.IntersectionObserver) { assign(); return; }
    if (!imageObserver) {
      imageObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          if (entry.target.__assignImage) entry.target.__assignImage();
          imageObserver.unobserve(entry.target);
        });
      }, { root: els.wall, rootMargin: '500px 0px' });
    }
    imageObserver.observe(card);
  }

  function makeCard(item, index, isClone) {
    var card = el('article', 'card' + (item.type === 'video' ? ' is-video' : ''));
    card.__item = item;
    card.style.setProperty('--ar', aspectOf(item).toFixed(4));
    card.dataset.index = String(index);

    var media = el('div', 'card-media');
    var node;

    if (item.type === 'video') {
      node = document.createElement('video');
      node.className = 'media-video';
      node.muted = true;
      node.loop = true;
      node.playsInline = true;
      node.setAttribute('muted', '');
      node.setAttribute('playsinline', '');
      node.setAttribute('webkit-playsinline', '');
      node.setAttribute('preload', 'none');
      node.setAttribute('disablepictureinpicture', '');
      node.setAttribute('aria-hidden', 'true');
      node.dataset.src = item.file;
      if (item.poster) node.poster = item.poster;

      var posterSrc = item.poster || item.thumb;
      if (!posterSrc) {
        // 没有封面图时（比如没装 ffmpeg），用带播放图标的渐变底代替黑块
        media.appendChild(el('div', 'card-video-fallback'));
      }
      if (posterSrc) {
        var probe = new Image();
        probe.onload = function () {
          node.classList.add('is-ready');
          card.classList.add('is-loaded');
        };
        probe.onerror = function () {
          node.classList.add('is-ready');
          card.classList.add('is-loaded');
        };
        probe.src = posterSrc;
      } else {
        card.classList.add('is-loaded');
        node.classList.add('is-ready');
      }
      media.appendChild(node);

      var badge = el('span', 'badge-video');
      badge.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>视频';
      card.appendChild(badge);

      registerVideo(card, node);
    } else {
      node = document.createElement('img');
      node.className = 'media-img';
      node.decoding = 'async';
      node.draggable = false;
      node.alt = item.title ? item.title : '照片';
      media.appendChild(node);
      loadImage(card, node);
      observeImage(card, node, item.thumb || item.file);
    }

    card.appendChild(media);

    var zoomIcon = el('span', 'card-zoom');
    zoomIcon.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6"/></svg>';
    card.appendChild(zoomIcon);

    if (item.title || item.date) {
      var cap = el('div', 'card-caption');
      if (item.title) cap.appendChild(el('p', 'card-title', item.title));
      if (item.date) cap.appendChild(el('p', 'card-date', formatDate(item.date)));
      card.appendChild(cap);
    }

    // 复制出来的卡片同样能点开大图（它们才是循环里常见的那些）
    card.addEventListener('click', function () {
      openLightbox(index, card);
    });

    if (isClone) {
      card.setAttribute('aria-hidden', 'true');
      card.dataset.dup = '1';
      card.tabIndex = -1;
    } else {
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', (item.title || (item.type === 'video' ? '视频' : '照片')) + '，点按查看大图');
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          openLightbox(index, card);
        }
      });
    }

    if (reduced) card.style.setProperty('--hover-scale', '1.015');

    return card;
  }

  /* ---------------- 视频懒加载 ---------------- */
  function registerVideo(card, video) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          VM.visible.add(video);
          VM.want(video);
        } else {
          VM.visible.delete(video);
          VM.release(video);
        }
      });
    }, { root: document.getElementById('wall'), rootMargin: '80px 0px', threshold: 0.25 });

    io.observe(card);

    card.addEventListener('pointerenter', function () { VM.want(video); });
    card.addEventListener('pointerleave', function () {
      if (!VM.visible.has(video)) VM.release(video);
    });
  }

  /* ---------------- 布局 ---------------- */
  function pickRowCount() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    var base;
    if (w < 540) base = h > 780 ? 3 : 2;
    else if (w < 900) base = 3;
    else if (w < 1180) base = 4;
    else base = h >= 1000 ? 5 : 4;
    return clamp(Math.min(base, CFG.rows, items.length), 1, 6);
  }

  function rowHeights(count) {
    var available = els.wall.clientHeight;
    if (!available) available = window.innerHeight * 0.62;
    var factors = ROW_FACTORS.slice(0, count);
    var sum = factors.reduce(function (a, b) { return a + b; }, 0);
    var pads = count * VPAD * 2;
    var unit = Math.max((available - pads) / sum, 0);
    return factors.map(function (f) {
      return clamp(unit * f, MIN_CARD_H, MAX_CARD_H);
    });
  }

  function buildWall() {
    els.wall.innerHTML = '';
    state.rows = [];
    state.offsetByRow = [];

    if (!items.length) {
      els.wall.classList.add('is-empty');
      var empty = el('div', 'wall-empty');
      empty.innerHTML =
        '<strong>还没有照片和视频</strong>' +
        '把照片放进 <code>media/photos</code>，视频放进 <code>media/videos</code><br>' +
        '然后双击 <code>启动.bat</code>（会自动生成清单）<br>' +
        '刷新页面，就会出现在墙上了';
      els.wall.appendChild(empty);
      return;
    }

    els.wall.classList.remove('is-empty');

    var rowCount = pickRowCount();
    var heights = rowHeights(rowCount);
    var shuffled = shuffle(items.slice(), CFG.shuffleSeed);

    for (var r = 0; r < rowCount; r++) {
      var rowItems = [];
      for (var i = r; i < shuffled.length; i += rowCount) rowItems.push(shuffled[i]);
      if (!rowItems.length) rowItems = shuffled.slice(0, 1);

      var dir = r % 2 === 0 ? -1 : 1;         // -1 向左，+1 向右
      var cardH = heights[r];

      var row = el('div', 'row');
      row.style.padding = VPAD + 'px 0';
      row.style.setProperty('--card-h', cardH.toFixed(2) + 'px');
      row.style.transitionDelay = (r * 80) + 'ms';

      var track = el('div', 'row-track');
      track.style.gap = CFG.gap + 'px';

      var entries = rowItems.map(function (item) {
        return { item: item, idx: items.indexOf(item) };
      });

      var firstCopy = [];
      entries.forEach(function (entry) {
        var card = makeCard(entry.item, entry.idx, false);
        track.appendChild(card);
        firstCopy.push(card);
      });

      // 先挂到页面上，才能量出真实宽度
      row.appendChild(track);
      els.wall.appendChild(row);

      // 量出“一个循环”的宽度，再复制到足够覆盖整屏，实现无缝
      var period = 0;
      firstCopy.forEach(function (c) { period += c.getBoundingClientRect().width; });
      period += firstCopy.length * CFG.gap;
      if (!period || period < 1) period = 1;

      var copies = Math.max(2, Math.ceil(els.wall.clientWidth / period) + 1);
      for (var c = 1; c < copies; c++) {
        entries.forEach(function (entry) {
          track.appendChild(makeCard(entry.item, entry.idx, true));
        });
      }

      state.rows.push({
        row: row,
        track: track,
        dir: dir,
        speed: CFG.speed * (dir < 0 ? 1 : 0.9) * (0.86 + ((r * 7) % 5) * 0.035),
        period: period,
        offset: dir < 0 ? 0 : -period,
        slow: 1,
        target: 1,
        visible: true,
        videos: []
      });

      requestAnimationFrame(function (rowEl) {
        return function () { rowEl.classList.add('is-shown'); };
      }(row));
    }

    state.rows.forEach(function (rowState, i) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          rowState.visible = e.isIntersecting;
          if (!rowState.visible) {
            rowState.track.querySelectorAll('video.is-ready').forEach(function (v) { v.pause(); });
          }
        });
      }, { root: els.wall, threshold: 0.01 });
      io.observe(rowState.row);
    });
  }

  /* ---------------- 滚动 ---------------- */
  function startLoop() {
    cancelAnimationFrame(state.rafId);
    if (!state.moving) return;
    state.lastTime = performance.now();

    function frame(now) {
      var dt = Math.min((now - state.lastTime) / 1000, 0.05);
      state.lastTime = now;

      if (!state.open && document.visibilityState !== 'hidden') {
        for (var i = 0; i < state.rows.length; i++) {
          var rs = state.rows[i];
          if (!rs.visible) continue;
          rs.slow += (rs.target - rs.slow) * Math.min(1, dt * 5.5);
          rs.offset += rs.dir * rs.speed * rs.slow * dt;
          if (rs.offset <= -rs.period) rs.offset += rs.period;
          else if (rs.offset > 0) rs.offset -= rs.period;
          rs.track.style.transform = 'translate3d(' + rs.offset.toFixed(2) + 'px, 0, 0)';
        }
      }
      state.rafId = requestAnimationFrame(frame);
    }

    state.rafId = requestAnimationFrame(frame);
  }

  function bindRowHover() {
    els.wall.addEventListener('pointerover', function (e) {
      var row = e.target.closest ? e.target.closest('.row') : null;
      if (!row) return;
      state.rows.forEach(function (rs) { rs.target = rs.row === row ? CFG.hoverSlowdown : 1; });
    });
    els.wall.addEventListener('pointerleave', function () {
      state.rows.forEach(function (rs) { rs.target = 1; });
    });
    els.wall.addEventListener('pointerout', function (e) {
      if (e.relatedTarget && els.wall.contains(e.relatedTarget)) return;
      state.rows.forEach(function (rs) { rs.target = 1; });
    });
  }

  /* ---------------- 大图 ---------------- */
  function updateCounter() {
    els.counter.textContent = String(state.index + 1).padStart(2, '0') + ' / ' + String(items.length).padStart(2, '0');
  }

  function updateCaption() {
    var item = items[state.index];
    els.caption.textContent = '';
    if (!item) return;
    var h = el('h2', null, item.title || (item.type === 'video' ? '我们的视频' : '我们的照片'));
    els.caption.appendChild(h);
    var bits = [];
    if (item.date) bits.push(formatDate(item.date));
    if (item.note) bits.push(item.note);
    if (!bits.length) bits.push(item.type === 'video' ? '视频' : '照片');
    els.caption.appendChild(el('p', null, bits.join(' · ')));
  }

  function applyZoom() {
    if (!els.lbZoom) return;
    els.lbZoom.style.transform = 'translate3d(' + zoom.x.toFixed(2) + 'px, ' + zoom.y.toFixed(2) + 'px, 0) scale(' + zoom.s.toFixed(3) + ')';
    els.lbZoom.classList.toggle('is-zoomed', zoom.s > 1.01);
  }

  function resetZoom() {
    zoom.s = 1; zoom.x = 0; zoom.y = 0;
    if (!els.lbZoom) return;
    els.lbZoom.classList.remove('is-dragging');
    els.lbZoom.style.transform = '';
  }

  function clampPan() {
    if (zoom.s <= 1.01) { zoom.x = 0; zoom.y = 0; return; }
    var r = els.stage.getBoundingClientRect();
    var mx = r.width * (zoom.s - 1) / 2 + 40;
    var my = r.height * (zoom.s - 1) / 2 + 40;
    zoom.x = clamp(zoom.x, -mx, mx);
    zoom.y = clamp(zoom.y, -my, my);
  }

  function setZoom(next, cx, cy) {
    var s0 = zoom.s;
    var s1 = clamp(next, 1, 4);
    if (s1 < 1.03) {
      zoom.s = 1; zoom.x = 0; zoom.y = 0;
      applyZoom();
      return;
    }
    var r = els.stage.getBoundingClientRect();
    var ox = r.left + r.width / 2;
    var oy = r.top + r.height / 2;
    var lx = (cx - ox - zoom.x) / s0;
    var ly = (cy - oy - zoom.y) / s0;
    zoom.s = s1;
    zoom.x = cx - ox - lx * s1;
    zoom.y = cy - oy - ly * s1;
    clampPan();
    applyZoom();
  }

  function stopLightboxVideo() {
    if (state.lbVideo) {
      try { state.lbVideo.pause(); } catch (e) {}
      state.lbVideo.removeAttribute('src');
      try { state.lbVideo.load(); } catch (e) {}
      state.lbVideo = null;
    }
  }

  function flipFrom(media, cardRect) {
    if (!cardRect || cardRect.width < 4) return;
    var r = media.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var s = cardRect.width / r.width;
    var dx = (cardRect.left + cardRect.width / 2) - (r.left + r.width / 2);
    var dy = (cardRect.top + cardRect.height / 2) - (r.top + r.height / 2);
    media.style.transform = 'translate3d(' + dx.toFixed(1) + 'px, ' + dy.toFixed(1) + 'px, 0) scale(' + s.toFixed(3) + ')';
    void media.offsetWidth;
    media.classList.add('is-flipping');
    media.addEventListener('transitionend', function onEnd() {
      media.classList.remove('is-flipping');
      media.style.transform = '';
      media.removeEventListener('transitionend', onEnd);
    });
    requestAnimationFrame(function () {
      media.style.transform = '';
    });
  }

  function preloadNeighbors() {
    if (items.length < 2) return;
    [1, -1].forEach(function (d) {
      var it = items[(state.index + d + items.length) % items.length];
      if (it && it.type === 'photo') { var im = new Image(); im.src = it.file; }
    });
  }

  function renderSlide(fromCard) {
    stopLightboxVideo();
    els.stage.textContent = '';
    resetZoom();

    var item = items[state.index];
    if (!item) return;

    var zoomWrap = el('div', 'lb-zoom');
    els.lbZoom = zoomWrap;
    var node;

    if (item.type === 'video') {
      node = document.createElement('video');
      node.className = 'lb-media';
      node.controls = true;
      node.playsInline = true;
      node.setAttribute('controls', '');
      node.setAttribute('playsinline', '');
      node.setAttribute('preload', 'auto');
      if (item.w) node.width = item.w;
      if (item.h) node.height = item.h;
      if (item.poster) node.poster = item.poster;
      node.src = item.file;
      node.autoplay = true;
      node.muted = false;
      node.volume = 1;
      node.addEventListener('loadeddata', function () { node.classList.add('is-ready'); });
      node.addEventListener('error', function () { node.classList.add('is-ready'); });
      var playPromise = node.play();
      if (playPromise && playPromise.catch) {
        playPromise.catch(function () {
          node.muted = true;
          var p2 = node.play();
          if (p2 && p2.catch) p2.catch(function () {});
        });
      }
      state.lbVideo = node;
      els.tip.textContent = CFG.tipVideo;
    } else {
      node = document.createElement('img');
      node.className = 'lb-media';
      node.alt = item.title || '照片';
      node.draggable = false;
      // 先用缩略图占位（多半已经在缓存里），原图加载完再无缝替换
      if (item.w) node.width = item.w;
      if (item.h) node.height = item.h;
      node.classList.add('is-ready');

      var fullSrc = item.file || item.thumb;
      var previewSrc = item.thumb || fullSrc;
      var triedFull = false;
      node.addEventListener('error', function () {
        if (!triedFull && fullSrc) { triedFull = true; node.src = fullSrc; }
      });
      node.src = previewSrc;

      if (fullSrc && fullSrc !== previewSrc) {
        var full = new Image();
        full.onload = function () {
          if (els.lbZoom === zoomWrap && node.isConnected) node.src = full.src;
        };
        full.src = fullSrc;
      }
      els.tip.textContent = CFG.tipImage;
    }

    els.lbZoom.appendChild(node);
    els.stage.appendChild(els.lbZoom);
    resetZoom();

    updateCounter();
    updateCaption();
    preloadNeighbors();
    els.btnPrev.disabled = items.length < 2;
    els.btnNext.disabled = items.length < 2;

    if (fromCard) flipFrom(node, fromCard.getBoundingClientRect());
  }

  function openLightbox(index, card) {
    if (!items.length) return;
    state.index = ((index % items.length) + items.length) % items.length;
    state.lastCard = card || null;
    state.open = true;
    clearTimeout(state.hideTimer);

    els.lightbox.hidden = false;
    document.body.classList.add('lb-open');
    VM.pauseAll();
    renderSlide(card);
    requestAnimationFrame(function () {
      els.lightbox.classList.add('is-open');
      els.btnClose.focus({ preventScroll: true });
    });
  }

  function closeLightbox() {
    if (!state.open) return;
    state.open = false;
    els.lightbox.classList.remove('is-open');
    document.body.classList.remove('lb-open');
    stopLightboxVideo();
    resetZoom();
    state.hideTimer = setTimeout(function () {
      if (state.open) return;
      els.lightbox.hidden = true;
      els.stage.textContent = '';
    }, 280);
    if (state.lastCard && document.contains(state.lastCard)) {
      state.lastCard.focus({ preventScroll: true });
    }
    state.lastCard = null;
    VM.resumeVisible();
  }

  function go(delta) {
    if (!state.open || items.length < 2) return;
    state.index = (state.index + delta + items.length) % items.length;
    renderSlide();
  }

  /* ---------------- 大图交互 ---------------- */
  function bindLightbox() {
    els.btnClose.addEventListener('click', closeLightbox);
    els.backdrop.addEventListener('click', closeLightbox);
    els.btnPrev.addEventListener('click', function (e) { e.stopPropagation(); go(-1); });
    els.btnNext.addEventListener('click', function (e) { e.stopPropagation(); go(1); });

    els.stage.addEventListener('wheel', function (e) {
      if (!state.open || state.lbVideo) return;
      e.preventDefault();
      setZoom(zoom.s * Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY);
    }, { passive: false });

    els.stage.addEventListener('dblclick', function (e) {
      if (!state.open || state.lbVideo) return;
      if (!e.target.closest('.lb-media')) return;
      if (zoom.s > 1.05) resetZoom();
      else setZoom(2.4, e.clientX, e.clientY);
    });

    var pt = null;

    els.stage.addEventListener('pointerdown', function (e) {
      if (!state.open) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      var onMedia = e.target.closest('.lb-media');
      pt = {
        id: e.pointerId,
        x0: e.clientX, y0: e.clientY,
        pan: !!(onMedia && zoom.s > 1.01),
        zx: zoom.x, zy: zoom.y
      };
      if (pt.pan) {
        els.lbZoom.classList.add('is-dragging');
        try { els.stage.setPointerCapture(e.pointerId); } catch (err) {}
      }
    });

    els.stage.addEventListener('pointermove', function (e) {
      if (!pt || e.pointerId !== pt.id) return;
      var dx = e.clientX - pt.x0;
      var dy = e.clientY - pt.y0;
      if (pt.pan) {
        zoom.x = pt.zx + dx;
        zoom.y = pt.zy + dy;
        clampPan();
        applyZoom();
      }
    });

    els.stage.addEventListener('pointerup', function (e) {
      if (!pt || e.pointerId !== pt.id) return;
      var dx = e.clientX - pt.x0;
      var dy = e.clientY - pt.y0;
      var wasPan = pt.pan;
      pt = null;
      if (wasPan) {
        els.lbZoom.classList.remove('is-dragging');
      } else if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        state.suppressClick = true;
        go(dx < 0 ? 1 : -1);
        setTimeout(function () { state.suppressClick = false; }, 120);
        return;
      }
      try { els.stage.releasePointerCapture(e.pointerId); } catch (err) {}
      setTimeout(function () { state.suppressClick = false; }, 120);
    });

    els.stage.addEventListener('pointercancel', function () {
      if (pt && pt.pan) els.lbZoom.classList.remove('is-dragging');
      pt = null;
    });

    els.stage.addEventListener('click', function (e) {
      if (!state.open || state.suppressClick) return;
      if (e.target.closest('.lb-media')) return;
      if (e.target.closest('.lb-nav') || e.target.closest('.lb-btn')) return;
      closeLightbox();
    });

    document.addEventListener('keydown', function (e) {
      if (!state.open) return;
      if (e.key === 'Escape') { closeLightbox(); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); return; }
      if (e.key === ' ' || e.key === 'Spacebar') {
        if (state.lbVideo) {
          e.preventDefault();
          if (state.lbVideo.paused) state.lbVideo.play().catch(function () {});
          else state.lbVideo.pause();
        }
      }
      if (e.key === '0') { resetZoom(); }
    });
  }

  /* ---------------- 文案 / 音乐 ---------------- */
  function applyConfig() {
    document.documentElement.setAttribute('data-theme', CFG.theme || 'rose');
    document.documentElement.style.setProperty('--hover-scale', String(CFG.hoverScale));
    if (els.eyebrow) els.eyebrow.textContent = CFG.eyebrow || '';
    if (els.title) els.title.textContent = CFG.title || '我们的时光';
    if (els.subtitle) { els.subtitle.textContent = CFG.subtitle || ''; els.subtitle.hidden = !CFG.subtitle; }
    if (els.signature) { els.signature.textContent = CFG.signature || ''; els.signature.hidden = !CFG.signature; }
    if (els.hint && reduced) els.hint.textContent = '点击查看大图';
    document.title = (CFG.title || '我们的时光') + ' · 照片墙';

    if (CFG.startDate) {
      var d = new Date(CFG.startDate + 'T00:00:00');
      if (!isNaN(d.getTime())) {
        var now = new Date();
        var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        var days = Math.floor((today - d) / 86400000) + 1;
        if (days > 0) {
          els.days.innerHTML = '在一起的第 <b>' + days.toLocaleString('en-US') + '</b> 天';
          els.days.hidden = false;
        }
      }
    }

    var photos = (DATA.photos || []).length;
    var videos = (DATA.videos || []).length;
    var parts = [];
    if (photos) parts.push('<b>' + photos + '</b> 张照片');
    if (videos) parts.push('<b>' + videos + '</b> 段视频');
    if (parts.length) {
      els.count.innerHTML = parts.join(' · ');
      els.count.hidden = false;
    }
  }

  function initBgm() {
    if (!CFG.bgm || !els.audio) return;
    els.audio.src = CFG.bgm;
    els.bgmBtn.hidden = false;
    els.bgmBtn.addEventListener('click', function () {
      if (els.audio.paused) {
        els.audio.volume = 0.55;
        var p = els.audio.play();
        if (p && p.then) p.then(function () { els.bgmBtn.classList.add('is-playing'); }).catch(function () {});
      } else {
        els.audio.pause();
        els.bgmBtn.classList.remove('is-playing');
      }
    });
  }

  /* ---------------- 尺寸变化 ---------------- */
  var resizeTimer = 0;
  var lastWallSize = '';

  function relayout() {
    var size = els.wall.clientWidth + 'x' + els.wall.clientHeight;
    if (size === lastWallSize) return;
    lastWallSize = size;
    var wasOpen = state.open;
    if (wasOpen) closeLightbox();
    buildWall();
    if (state.moving) startLoop();
  }

  function scheduleRelayout() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 220);
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    buildItems();
    applyConfig();
    initBgm();
    bindRowHover();
    bindLightbox();

    // 等一帧拿到真实高度再布局
    requestAnimationFrame(function () {
      relayout();
      lastWallSize = els.wall.clientWidth + 'x' + els.wall.clientHeight;
      document.body.classList.add('is-loaded');
      if (state.moving) startLoop();
    });

    window.addEventListener('resize', scheduleRelayout);
    window.addEventListener('orientationchange', scheduleRelayout);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(scheduleRelayout);
    }

    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { scheduleRelayout(); });
      ro.observe(els.wall);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        VM.pauseAll();
      } else {
        VM.resumeVisible();
      }
      state.lastTime = performance.now();
    });

    setTimeout(function () {
      if (els.hint) els.hint.classList.add('is-faded');
    }, 7000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
