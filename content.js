(async function init() {
  function isExtensionValid() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  let currentHost = window.location.hostname;
  try {
    if (!currentHost && window.parent) {
      currentHost = new URL(document.referrer).hostname;
    }
  } catch (e) {
    currentHost = currentHost || 'unknown';
  }

  function getStorageData(keys) {
    return new Promise((resolve) => {
      if (!isExtensionValid()) return resolve({});
      try {
        if (!chrome.storage?.local) return resolve({});
        chrome.storage.local.get(keys, (result) => {
          if (!isExtensionValid() || chrome.runtime?.lastError) return resolve({});
          resolve(result || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  function setStorageData(data) {
    if (!isExtensionValid()) return;
    try {
      if (!chrome.storage?.local) return;
      chrome.storage.local.set(data, () => {
        if (!isExtensionValid() || chrome.runtime?.lastError) { /* ignore */ }
      });
    } catch (e) {
      /* ignore */
    }
  }

  // Пределы скорости больше не настраиваются пользователем
  const MIN_SPEED = 0.1;
  const MAX_SPEED = 16.0;
  // Максимальное усиление громкости (3.0 = 300%)
  const MAX_VOLUME_BOOST = 3.0;

  // Встроенные шрифты. Список должен совпадать со списком в popup.js
  const BUILTIN_FONTS = {
    system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    arial: "Arial, Helvetica, sans-serif",
    verdana: "Verdana, Geneva, sans-serif",
    tahoma: "Tahoma, Geneva, sans-serif",
    trebuchet: "'Trebuchet MS', Helvetica, sans-serif",
    georgia: "Georgia, 'Times New Roman', serif",
    times: "'Times New Roman', Times, serif",
    mono: "Consolas, Monaco, 'Courier New', monospace",
    courier: "'Courier New', Courier, monospace"
  };

  const defaultSettings = {
    showIndicatorOnLoad: false,
    speedStep: 0.1,
    resetSpeed: 1.0,
    rewindBackSec: 10,
    rewindForwardSec: 10,
    undoRewindCombo: { ctrl: true, shift: false, alt: false, code: 'KeyZ' },
    undoRewindDelaySec: 2,
    directInputCombo: { ctrl: true, shift: true, alt: false, code: '' },
    codeRewindBack: 'KeyJ',
    codeRewindForward: 'KeyL',
    codeFrameBack: 'Comma',
    codeFrameForward: 'Period',
    digitSeekMode: 'both',
    timecodeModifier: { ctrl: false, shift: false, alt: true, code: '' },
    customSpeedBinds: [],
    customRewindBinds: [],
    textColor: '#ffffff',
    bgColorRgba: 'rgba(0, 0, 0, 0.85)',
    fontSize: 16,
    fontFamily: 'default',
    posNormal: 'top-center',
    posFullscreen: 'top-center',
    blacklist: [],
    siteSpeeds: {},
    siteVolumes: {}
  };

  let settings = await getStorageData(defaultSettings);
  settings = { ...defaultSettings, ...settings };

  function getSavedSpeed() {
    const hostEntry = settings.siteSpeeds?.[currentHost];
    if (typeof hostEntry === 'number') {
      return hostEntry;
    }
    if (typeof hostEntry === 'object' && hostEntry !== null) {
      return hostEntry.video !== undefined ? hostEntry.video : (hostEntry.audio !== undefined ? hostEntry.audio : 1.0);
    }
    return 1.0;
  }

  function saveSpeed(speed) {
    const siteSpeeds = settings.siteSpeeds || {};
    siteSpeeds[currentHost] = speed;
    settings.siteSpeeds = siteSpeeds;

    getStorageData({ siteSpeeds: {} }).then((data) => {
      const speeds = data.siteSpeeds || {};
      speeds[currentHost] = speed;
      setStorageData({ siteSpeeds: speeds });
    });
  }

  // До какой скорости сбрасывает Ctrl + ЛКМ (настраивается в popup)
  function getResetSpeed() {
    const value = parseFloat(settings.resetSpeed);
    return isFinite(value) && value > 0 ? value : 1.0;
  }

  // Усиление громкости хранится отдельно для каждого сайта: 1.0 = 100%, 3.0 = 300%
  function getSavedVolumeBoost() {
    const value = parseFloat(settings.siteVolumes?.[currentHost]);
    if (!isFinite(value)) return 1.0;
    return Math.min(MAX_VOLUME_BOOST, Math.max(1.0, value));
  }

  let volumeSaveTimer = null;
  let volumeSavePending = false;

  function saveVolumeBoost(boost) {
    const siteVolumes = { ...(settings.siteVolumes || {}) };
    if (boost > 1) siteVolumes[currentHost] = boost;
    else delete siteVolumes[currentHost];
    settings.siteVolumes = siteVolumes;

    // Ползунок шлёт много значений подряд, поэтому в хранилище пишем только последнее
    volumeSavePending = true;
    clearTimeout(volumeSaveTimer);
    volumeSaveTimer = setTimeout(() => {
      volumeSavePending = false;
      getStorageData({ siteVolumes: {} }).then((data) => {
        const volumes = data.siteVolumes || {};
        if (boost > 1) volumes[currentHost] = boost;
        else delete volumes[currentHost];
        setStorageData({ siteVolumes: volumes });
      });
    }, 300);
  }

  let isInternalSettingRate = false;

  function forceSetSpeed(media, speed) {
    try {
      isInternalSettingRate = true;
      media.playbackRate = speed;
    } catch (e) {
      /* ignore */
    } finally {
      isInternalSettingRate = false;
    }
  }

  function isFeatureDisabled(featureName) {
    if (!settings.blacklist || !Array.isArray(settings.blacklist)) return false;
    const item = settings.blacklist.find(entry => {
      if (typeof entry === 'string') return currentHost.includes(entry);
      return entry && entry.domain && currentHost.includes(entry.domain);
    });
    if (!item) return false;
    if (typeof item === 'string') return true;
    if (item.enabledFeatures) {
      return item.enabledFeatures[featureName] === false;
    }
    return false;
  }

  function getRewindSecs() {
    return {
      backSec: parseInt(settings.rewindBackSec, 10) || 10,
      fwdSec: parseInt(settings.rewindForwardSec, 10) || 10
    };
  }

  function getMediaDuration(media) {
    if (!media) return 0;
    if (isFinite(media.duration) && media.duration > 0) return media.duration;
    if (media.seekable && media.seekable.length > 0) {
      const end = media.seekable.end(media.seekable.length - 1);
      if (isFinite(end) && end > 0) return end;
    }
    return 0;
  }

  let indicatorTimeout = null;
  let rewindOverlayTimeout = null; // Отдельный таймер для плашки перемотки
  let isDirectInputActive = false;
  let speedInputBuffer = "";
  let speedInputTimer = null;

  let rewindAccumulator = 0;
  let rewindTimeout = null;

  // Отмена перемотки: позиция, с которой началась серия перемоток
  let undoState = null; // { media, time, src }
  let undoTimer = null;

  let isTimecodeInputActive = false;
  let timecodeBuffer = "";
  let timecodeTimer = null;

  let lastMouseX = 0;
  let lastMouseY = 0;

  window.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  }, { passive: true, capture: true });

  function getAllMediaDeep(root = document) {
    let list = [];
    try {
      const elements = root.querySelectorAll('video, audio');
      list.push(...Array.from(elements));

      const allNodes = root.querySelectorAll('*');
      for (const node of allNodes) {
        if (node.shadowRoot) {
          list.push(...getAllMediaDeep(node.shadowRoot));
        }
      }
    } catch (e) {}
    return list;
  }

  function getElementUnderCursorDeep(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const nested = el.shadowRoot.elementFromPoint(x, y);
      if (!nested || nested === el) break;
      el = nested;
    }
    return el;
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.tagName === 'AUDIO') return true;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function isHoveringMediaOrPlayer() {
    if (lastMouseX <= 0 && lastMouseY <= 0) return false;
    const el = getElementUnderCursorDeep(lastMouseX, lastMouseY);
    if (!el) return false;

    if (el.closest('video, audio')) return true;
    if (el.closest([
      '.html5-video-player',
      '.round-video-player',
      '.audio-player',
      '.voice-message',
      '.Voice',
      '.VoiceMessage',
      '.bubble-voice',
      '.audio-track',
      '.waveform',
      '[class*="Voice"]',
      '[class*="waveform"]',
      '.is-voice'
    ].join(','))) return true;

    return false;
  }

  function getActiveMedia() {
    const allMedia = getAllMediaDeep(document);
    if (allMedia.length === 0) return null;

    if (lastMouseX > 0 || lastMouseY > 0) {
      const elUnderCursor = getElementUnderCursorDeep(lastMouseX, lastMouseY);
      if (elUnderCursor) {
        const directMedia = elUnderCursor.closest('video, audio') || elUnderCursor.querySelector('video, audio');
        if (directMedia && isVisible(directMedia)) return directMedia;

        const playerContainer = elUnderCursor.closest([
          '.html5-video-player',
          '.round-video-player',
          '.audio-player',
          '.voice-message',
          '.Voice',
          '.VoiceMessage',
          '.bubble-voice',
          '.audio-track',
          '.waveform',
          '[class*="Voice"]',
          '[class*="waveform"]'
        ].join(','));

        if (playerContainer) {
          const m = playerContainer.querySelector('video, audio');
          if (m && isVisible(m)) return m;
        }
      }
    }

    const playingVisible = allMedia.filter(m => !m.paused && m.readyState > 0 && isVisible(m));
    if (playingVisible.length > 0) return playingVisible[0];

    const playing = allMedia.filter(m => !m.paused && m.readyState > 0);
    if (playing.length > 0) return playing[0];

    const visibleList = allMedia.filter(m => isVisible(m));
    if (visibleList.length > 0) return visibleList[0];

    return allMedia[0];
  }

  // ===== Усиление громкости (Web Audio API) =====
  // Штатная громкость <video> ограничена 100%, поэтому звук пропускаем через GainNode.
  // DynamicsCompressor сам добавляет компенсирующее усиление (makeup gain). Считаем его по формуле
  // из спецификации Web Audio и вычитаем из GainNode, чтобы 250% на ползунке давало ровно ×2.5.
  const LIMITER_THRESHOLD_DB = -2;
  const LIMITER_RATIO = 20;
  const LIMITER_MAKEUP = Math.pow(
    1 / Math.pow(10, (LIMITER_THRESHOLD_DB + (0 - LIMITER_THRESHOLD_DB) / LIMITER_RATIO) / 20),
    0.6
  );

  let audioCtx = null;
  const audioGraphs = new WeakMap(); // media -> { source, gain, limiter }
  const unsupportedMedia = new WeakSet(); // элементы, которые не удалось подключить

  function getAudioContext() {
    if (audioCtx && audioCtx.state !== 'closed') return audioCtx;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    try {
      audioCtx = new AudioContextClass();
      // Браузер запускает контекст только после действия пользователя на странице.
      // Пока контекст не запущен, видео мы не трогаем, поэтому звук не пропадает.
      audioCtx.onstatechange = () => {
        if (audioCtx && audioCtx.state === 'running') applyVolumeBoostToAll();
      };
    } catch (e) {
      audioCtx = null;
    }
    return audioCtx;
  }

  function resumeAudioContext() {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  }

  ['pointerdown', 'keydown', 'touchend', 'click'].forEach((evt) => {
    window.addEventListener(evt, resumeAudioContext, { capture: true, passive: true });
  });

  // true — усилить можно, false — нельзя, null — пока неизвестно (источник ещё не загружен)
  function getBoostSupport(media) {
    try {
      // Видео с защитой (DRM/EME) после подключения к Web Audio теряет звук
      if (media.mediaKeys) return false;
      if (media.srcObject) return true;
      const src = media.currentSrc;
      if (!src) return null;
      if (/^(blob|data):/i.test(src)) return true;
      // Чужой источник без CORS Web Audio превращает в тишину
      if (media.crossOrigin !== null) return true;
      const url = new URL(src, location.href);
      if (url.protocol === 'file:') return false;
      return url.origin === (window.origin || location.origin);
    } catch (e) {
      return false;
    }
  }

  function createAudioGraph(media, ctx) {
    let source;
    try {
      source = ctx.createMediaElementSource(media);
    } catch (e) {
      // Страница уже подключила этот элемент к своему AudioContext
      unsupportedMedia.add(media);
      return null;
    }

    try {
      const gain = ctx.createGain();
      // Лимитер не даёт звуку хрипеть, когда усиленный сигнал выходит за 0 дБ
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = LIMITER_THRESHOLD_DB;
      limiter.knee.value = 0;
      limiter.ratio.value = 1;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;

      source.connect(gain);
      gain.connect(limiter);
      limiter.connect(ctx.destination);

      const graph = { source, gain, limiter };
      audioGraphs.set(media, graph);
      return graph;
    } catch (e) {
      try { source.connect(ctx.destination); } catch (err) { /* ignore */ }
      unsupportedMedia.add(media);
      return null;
    }
  }

  function setGraphBoost(graph, boost) {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const gainParam = graph.gain.gain;
    // На 100% лимитер выключен (ratio 1): звук проходит без изменений
    const limiting = boost > 1;
    gainParam.cancelScheduledValues(now);
    gainParam.setValueAtTime(gainParam.value, now);
    gainParam.linearRampToValueAtTime(limiting ? boost / LIMITER_MAKEUP : boost, now + 0.05);
    graph.limiter.ratio.setValueAtTime(limiting ? LIMITER_RATIO : 1, now);
  }

  function applyVolumeBoost(media) {
    if (!media) return;
    const boost = isFeatureDisabled('volume') ? 1.0 : getSavedVolumeBoost();
    let graph = audioGraphs.get(media);

    if (!graph) {
      // Пока усиления нет, к видео вообще не прикасаемся
      if (boost <= 1 || unsupportedMedia.has(media)) return;

      // null — источник ещё не загружен (повторим по событию), false — усилить нельзя
      if (getBoostSupport(media) !== true) return;

      const ctx = getAudioContext();
      if (!ctx) return;
      if (ctx.state !== 'running') {
        ctx.resume().catch(() => {}); // дальше сработает onstatechange
        return;
      }

      graph = createAudioGraph(media, ctx);
      if (!graph) return;
    }

    setGraphBoost(graph, boost);
  }

  function applyVolumeBoostToAll() {
    getAllMediaDeep(document).forEach(applyVolumeBoost);
  }

  // 'ok' | 'pending' (ждём действия на странице) | 'unsupported' | 'disabled'
  function getVolumeStatus(media) {
    if (isFeatureDisabled('volume')) return 'disabled';
    if (!media) return 'ok';
    if (unsupportedMedia.has(media) || getBoostSupport(media) === false) return 'unsupported';
    if (getSavedVolumeBoost() > 1 && !audioGraphs.has(media)) return 'pending';
    return 'ok';
  }

  function setVolumeBoost(rawBoost, media) {
    if (isFeatureDisabled('volume')) return;
    const parsed = parseFloat(rawBoost);
    if (!isFinite(parsed)) return;

    const boost = Math.round(Math.min(MAX_VOLUME_BOOST, Math.max(1, parsed)) * 100) / 100;
    saveVolumeBoost(boost);
    applyVolumeBoostToAll();

    const percent = `${Math.round(boost * 100)}%`;
    const status = boost > 1 ? getVolumeStatus(media) : 'ok';
    if (status === 'unsupported') {
      showIndicator('Усиление недоступно для этого видео');
    } else if (status === 'pending') {
      showIndicator(`Громкость: ${percent} (кликните по странице)`);
    } else {
      showIndicator(`Громкость: ${percent}`);
    }
  }

  // ===== Шрифт плашек =====
  const loadedCustomFonts = new Map(); // id -> FontFace | 'loading' | 'failed'

  function customFontFamilyName(id) {
    return 'OverclockFont_' + String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  // Свой шрифт подключаем через FontFace API из бинарных данных: так его не блокирует CSP сайта
  async function loadCustomFont(id) {
    if (!id || loadedCustomFonts.has(id)) return;
    loadedCustomFonts.set(id, 'loading');
    try {
      const key = `customFont_${id}`;
      const data = await getStorageData({ [key]: '' });
      if (!data[key]) throw new Error('font not found');
      // weight 100-900 — чтобы браузер не делал "жирную" копию поверх файла шрифта
      const face = new FontFace(customFontFamilyName(id), base64ToArrayBuffer(data[key]), { weight: '100 900' });
      await face.load();
      document.fonts.add(face);
      loadedCustomFonts.set(id, face);
    } catch (e) {
      loadedCustomFonts.set(id, 'failed');
    }
  }

  function unloadCustomFont(id) {
    const face = loadedCustomFonts.get(id);
    if (face && typeof face === 'object') {
      try { document.fonts.delete(face); } catch (e) { /* ignore */ }
    }
    loadedCustomFonts.delete(id);
  }

  function preloadOverlayFont() {
    const id = typeof settings.fontFamily === 'string' ? settings.fontFamily : '';
    if (id.startsWith('custom:')) loadCustomFont(id.slice(7));
  }

  // defaultStack — шрифт плашки "по умолчанию" (у каждой плашки он свой)
  function getOverlayFontFamily(defaultStack) {
    const id = typeof settings.fontFamily === 'string' ? settings.fontFamily : 'default';
    if (id.startsWith('custom:')) {
      const fontId = id.slice(7);
      loadCustomFont(fontId);
      return `"${customFontFamilyName(fontId)}", ${defaultStack}`;
    }
    if (Object.prototype.hasOwnProperty.call(BUILTIN_FONTS, id)) return BUILTIN_FONTS[id];
    return defaultStack;
  }

  if (isExtensionValid()) {
    try {
      chrome.storage?.onChanged?.addListener((changes) => {
        if (!isExtensionValid()) return;
        for (const key in changes) {
          // Файлы шрифтов большие: в settings их не копируем
          if (key.startsWith('customFont_')) {
            unloadCustomFont(key.slice('customFont_'.length));
            continue;
          }
          if (key === 'customFontsMeta') continue;
          // Пока не записано наше последнее значение громкости, чужое не применяем
          if (key === 'siteVolumes' && volumeSavePending) continue;
          settings[key] = changes[key].newValue;
        }

        // Усиление для этого сайта поменяли в другой вкладке или переключили чёрный список
        let volumeChanged = !!changes.blacklist;
        if (changes.siteVolumes && !volumeSavePending) {
          const oldBoost = changes.siteVolumes.oldValue?.[currentHost];
          const newBoost = changes.siteVolumes.newValue?.[currentHost];
          if (oldBoost !== newBoost) volumeChanged = true;
        }
        if (volumeChanged) applyVolumeBoostToAll();
      });
    } catch (e) {}

    try {
      chrome.runtime?.onMessage?.addListener((request, sender, sendResponse) => {
        if (!isExtensionValid() || !request) return;

        // Состояние страницы для popup. Отвечает фрейм, в котором есть видео
        if (request.action === 'getState') {
          const media = getActiveMedia();
          if (!media) return;

          const state = {
            host: currentHost,
            speed: media.playbackRate,
            volumeBoost: getSavedVolumeBoost(),
            volumeStatus: getVolumeStatus(media)
          };

          if (!media.paused) {
            sendResponse(state);
            return;
          }
          // Фреймы с играющим видео отвечают раньше фреймов с видео на паузе
          setTimeout(() => {
            try { sendResponse(state); } catch (e) { /* ignore */ }
          }, 150);
          return true;
        }

        if (request.action === 'setSpeed') {
          const media = getActiveMedia();
          if (!media) return;
          if (!isFeatureDisabled('speed')) {
            setMediaSpeed(media, request.speed, true);
          }
          sendResponse({ speed: media.playbackRate });
          return;
        }

        if (request.action === 'setVolumeBoost') {
          const media = getActiveMedia();
          if (!media) return;
          setVolumeBoost(request.boost, media);
          sendResponse({ volumeBoost: getSavedVolumeBoost(), volumeStatus: getVolumeStatus(media) });
        }
      });
    } catch (e) {}
  }

  function applyPositionStyles(indicator, pos) {
    indicator.style.top = 'auto';
    indicator.style.bottom = 'auto';
    indicator.style.left = 'auto';
    indicator.style.right = 'auto';
    indicator.style.transform = 'none';

    switch (pos) {
      case 'top-left':
        indicator.style.top = '20px';
        indicator.style.left = '20px';
        break;
      case 'top-right':
        indicator.style.top = '20px';
        indicator.style.right = '20px';
        break;
      case 'bottom-left':
        indicator.style.bottom = '20px';
        indicator.style.left = '20px';
        break;
      case 'bottom-center':
        indicator.style.bottom = '20px';
        indicator.style.left = '50%';
        indicator.style.transform = 'translateX(-50%)';
        break;
      case 'bottom-right':
        indicator.style.bottom = '20px';
        indicator.style.right = '20px';
        break;
      case 'top-center':
      default:
        indicator.style.top = '20px';
        indicator.style.left = '50%';
        indicator.style.transform = 'translateX(-50%)';
        break;
    }
  }

  function showIndicator(text) {
    let indicator = document.getElementById('custom-speed-indicator');

    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'custom-speed-indicator';
      (document.body || document.documentElement).appendChild(indicator);
    }

    const isFullscreen = !!document.fullscreenElement;
    const targetContainer = document.fullscreenElement || document.body || document.documentElement;

    if (targetContainer && indicator.parentElement !== targetContainer) {
      targetContainer.appendChild(indicator);
    }

    Object.assign(indicator.style, {
      position: 'fixed',
      backgroundColor: settings.bgColorRgba,
      color: settings.textColor,
      fontSize: `${settings.fontSize}px`,
      padding: '8px 16px',
      borderRadius: '8px',
      fontWeight: 'bold',
      fontFamily: getOverlayFontFamily('monospace, sans-serif'),
      zIndex: '2147483647',
      pointerEvents: 'none',
      transition: 'opacity 0.2s ease',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
      border: '1px solid rgba(255, 255, 255, 0.2)'
    });

    const pos = isFullscreen ? settings.posFullscreen : settings.posNormal;
    applyPositionStyles(indicator, pos);

    indicator.innerText = text;
    indicator.style.opacity = '1';

    clearTimeout(indicatorTimeout);
    indicatorTimeout = setTimeout(() => {
      indicator.style.opacity = '0';
    }, 800);
  }

  function showRewindOverlay(direction, totalSec) {
    const targetContainer = document.fullscreenElement || document.body || document.documentElement;
    let overlay = document.getElementById('custom-rewind-overlay');

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'custom-rewind-overlay';
      targetContainer.appendChild(overlay);
    } else if (overlay.parentElement !== targetContainer) {
      targetContainer.appendChild(overlay);
    }

    const isForward = direction === 'forward';

    Object.assign(overlay.style, {
      position: 'fixed',
      top: '50%',
      left: isForward ? 'auto' : '20px',
      right: isForward ? '20px' : 'auto',
      transform: 'translateY(-50%)',
      backgroundColor: 'rgba(0, 0, 0, 0.85)',
      color: '#ffffff',
      fontSize: '42px',
      fontWeight: '800',
      fontFamily: getOverlayFontFamily('system-ui, sans-serif'),
      padding: '20px 36px',
      borderRadius: '40px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transition: 'opacity 0.15s ease, transform 0.15s ease',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
      border: '2px solid rgba(255, 255, 255, 0.2)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    });

    const sign = isForward ? '+' : '-';
    overlay.innerText = `${sign}${totalSec}s`;
    overlay.style.opacity = '1';

    clearTimeout(rewindOverlayTimeout);
    rewindOverlayTimeout = setTimeout(() => {
      overlay.style.opacity = '0';
    }, 900);
  }

  // ===== Отмена перемотки =====
  function getUndoWindowMs() {
    const sec = parseFloat(settings.undoRewindDelaySec);
    if (!isFinite(sec) || sec <= 0) return 0;
    return Math.min(sec, 30) * 1000;
  }

  function clearUndoState() {
    undoState = null;
    clearTimeout(undoTimer);
    undoTimer = null;
  }

  // Запоминаем позицию ДО перемотки. Если перемоток несколько подряд (каждая в пределах
  // окна отмены), откат вернёт позицию, с которой началась вся серия.
  function recordUndoPoint(media) {
    const windowMs = getUndoWindowMs();
    if (!windowMs) {
      clearUndoState();
      return;
    }
    if (!undoState || undoState.media !== media) {
      undoState = { media, time: media.currentTime, src: media.currentSrc };
    }
    clearTimeout(undoTimer);
    undoTimer = setTimeout(clearUndoState, windowMs);
  }

  // Любая перемотка расширения (J/L, цифры, кадры, таймкод) идёт через эту функцию
  function seekTo(media, time) {
    recordUndoPoint(media);
    media.currentTime = time;
  }

  function undoLastSeek() {
    const state = undoState;
    clearUndoState();
    if (!state || !state.media || !state.media.isConnected) return false;
    if (state.media.currentSrc !== state.src) return false; // видео уже другое

    try {
      state.media.currentTime = state.time;
    } catch (e) {
      return false;
    }

    rewindAccumulator = 0;
    clearTimeout(rewindTimeout);
    const overlay = document.getElementById('custom-rewind-overlay');
    if (overlay) overlay.style.opacity = '0';

    showIndicator('Перемотка отменена');
    return true;
  }

  // Сочетание отмены с клавиатурой (мышиные кнопки обрабатываются в handleMouseHotkey)
  function matchesUndoCombo(e) {
    const combo = settings.undoRewindCombo;
    if (!combo || typeof combo !== 'object' || !combo.code || combo.code.startsWith('Mouse')) return false;
    return matchesCombo(e, combo);
  }

  function handleRewind(media, seconds, direction) {
    if (!media || isFeatureDisabled('rewind')) return;

    const delta = direction === 'forward' ? seconds : -seconds;

    if ((direction === 'forward' && rewindAccumulator < 0) || (direction === 'back' && rewindAccumulator > 0)) {
      rewindAccumulator = 0;
    }

    rewindAccumulator += delta;
    const duration = getMediaDuration(media);

    if (direction === 'forward') {
      seekTo(media, Math.min(duration || Infinity, media.currentTime + seconds));
    } else {
      seekTo(media, Math.max(0, media.currentTime - seconds));
    }

    const displaySec = Math.abs(rewindAccumulator);
    const displayDir = rewindAccumulator >= 0 ? 'forward' : 'back';
    showRewindOverlay(displayDir, displaySec);

    clearTimeout(rewindTimeout);
    rewindTimeout = setTimeout(() => {
      rewindAccumulator = 0;
    }, 1000);
  }

  function parseTimecodeBufferToSeconds(buffer) {
    if (!buffer) return 0;
    const clean = buffer.replace(/^0+/, '') || '0';
    if (clean === '0') return 0;

    const secStr = clean.length > 2 ? clean.slice(-2) : clean;
    const minStr = clean.length > 2 ? (clean.length > 4 ? clean.slice(-4, -2) : clean.slice(0, -2)) : '0';
    const hrsStr = clean.length > 4 ? clean.slice(0, -4) : '0';

    const secs = parseInt(secStr, 10) || 0;
    const mins = parseInt(minStr, 10) || 0;
    const hrs = parseInt(hrsStr, 10) || 0;

    return hrs * 3600 + mins * 60 + secs;
  }

  function renderTimecodeHTML(buffer) {
    const totalSec = parseTimecodeBufferToSeconds(buffer);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;

    const hStr = String(hrs).padStart(2, '0');
    const mStr = String(mins).padStart(2, '0');
    const sStr = String(secs).padStart(2, '0');

    const fullStr = `${hStr}:${mStr}:${sStr}`;
    let firstNonZeroFound = false;
    let html = '[';

    for (let i = 0; i < fullStr.length; i++) {
      const char = fullStr[i];
      if (char === ':') {
        html += `<span style="color: #ffffff; margin: 0 1px;">:</span>`;
      } else {
        if (char !== '0') {
          firstNonZeroFound = true;
        }
        if (firstNonZeroFound || (i === fullStr.length - 1 && totalSec === 0)) {
          html += `<span style="color: #ffffff; font-weight: bold;">${char}</span>`;
        } else {
          html += `<span style="color: #6b7280; font-weight: normal;">${char}</span>`;
        }
      }
    }
    html += ']';
    return html;
  }

  function updateTimecodeOverlay() {
    const targetContainer = document.fullscreenElement || document.body || document.documentElement;
    let overlay = document.getElementById('custom-timecode-overlay');

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'custom-timecode-overlay';
      targetContainer.appendChild(overlay);
    } else if (overlay.parentElement !== targetContainer) {
      targetContainer.appendChild(overlay);
    }

    Object.assign(overlay.style, {
      position: 'fixed',
      top: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      backgroundColor: 'rgba(0, 0, 0, 0.9)',
      color: '#ffffff',
      fontSize: '28px',
      fontWeight: 'bold',
      fontFamily: getOverlayFontFamily('Consolas, Monaco, monospace'),
      fontVariantNumeric: 'tabular-nums',
      padding: '10px 24px',
      borderRadius: '12px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transition: 'opacity 0.15s ease',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6)',
      border: '2px solid rgba(59, 130, 246, 0.8)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      letterSpacing: '2px'
    });

    overlay.innerHTML = renderTimecodeHTML(timecodeBuffer);
    overlay.style.opacity = '1';
  }

  function hideTimecodeOverlay() {
    const overlay = document.getElementById('custom-timecode-overlay');
    if (overlay) {
      overlay.style.opacity = '0';
    }
  }

  function setMediaSpeed(media, newSpeed, showUI = false) {
    if (isFeatureDisabled('speed')) return null;

    const parsedSpeed = parseFloat(newSpeed);
    if (!isFinite(parsedSpeed)) return null;

    let clampedSpeed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, parsedSpeed));
    clampedSpeed = Math.round(clampedSpeed * 100) / 100;

    forceSetSpeed(media, clampedSpeed);
    saveSpeed(clampedSpeed);

    if (showUI) {
      const pauseLabel = media.paused ? ' (Пауза)' : '';
      showIndicator(`${clampedSpeed.toFixed(2)}x${pauseLabel}`);
    }

    return clampedSpeed;
  }

  function attachMediaListeners(media) {
    if (media.dataset.speedControlAttached) return;
    media.dataset.speedControlAttached = "true";

    preloadOverlayFont();

    // Усиление громкости работает независимо от того, отключена ли на сайте скорость
    const syncVolume = () => applyVolumeBoost(media);
    ['loadstart', 'loadedmetadata', 'canplay', 'play', 'playing'].forEach(evt => {
      media.addEventListener(evt, syncVolume, true);
    });
    syncVolume();

    if (isFeatureDisabled('speed')) return;

    const syncSpeed = () => {
      if (isInternalSettingRate || isFeatureDisabled('speed')) return;
      const expectedSpeed = getSavedSpeed();
      if (Math.abs(media.playbackRate - expectedSpeed) > 0.01) {
        forceSetSpeed(media, expectedSpeed);
      }
    };

    const targetSpeed = getSavedSpeed();
    forceSetSpeed(media, targetSpeed);

    if (settings.showIndicatorOnLoad) {
      showIndicator(`${targetSpeed.toFixed(2)}x`);
    }

    const eventsToListen = [
      'ratechange', 'play', 'playing', 'loadedmetadata', 
      'canplay', 'timeupdate', 'loadstart', 'durationchange', 'seeking'
    ];
    eventsToListen.forEach(evt => media.addEventListener(evt, syncSpeed, true));
  }

  let observerTimeout = null;
  const scanAndAttach = () => {
    const mediaElements = getAllMediaDeep(document);
    mediaElements.forEach(attachMediaListeners);
  };

  const observer = new MutationObserver(() => {
    if (observerTimeout) return;
    observerTimeout = setTimeout(() => {
      observerTimeout = null;
      scanAndAttach();
    }, 200);
  });

  const setupObserver = () => {
    const target = document.documentElement || document.body;
    if (target) {
      observer.observe(target, { childList: true, subtree: true });
      scanAndAttach();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupObserver);
  } else {
    setupObserver();
  }

  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey && !isFeatureDisabled('speed')) {
      const media = getActiveMedia();
      if (!media) return;

      e.preventDefault();
      e.stopPropagation();

      let currentRate = media.playbackRate;
      const step = parseFloat(settings.speedStep) || 0.1;

      if (e.deltaY < 0) {
        currentRate += step;
      } else {
        currentRate -= step;
      }

      setMediaSpeed(media, currentRate, true);
    }
  }, { passive: false, capture: true });

  window.addEventListener('click', (e) => {
    if (e.ctrlKey && e.button === 0 && !isFeatureDisabled('speed')) {
      const media = getActiveMedia();
      if (!media) return;

      e.preventDefault();
      e.stopPropagation();

      setMediaSpeed(media, getResetSpeed(), true);
    }
  }, true);

  function matchesCombo(e, combo) {
    if (!combo) return false;
    if (typeof combo === 'string') {
      return e.code === combo;
    }
    const ctrlMatch = combo.ctrl === e.ctrlKey;
    const shiftMatch = combo.shift === e.shiftKey;
    const altMatch = combo.alt === e.altKey;
    const codeMatch = combo.code ? combo.code === e.code : true;
    return ctrlMatch && shiftMatch && altMatch && codeMatch;
  }

  function convertCodeToChar(e) {
    if (e.code.startsWith('Digit')) {
      return e.code.replace('Digit', '');
    }
    if (e.code.startsWith('Numpad') && e.code.length === 7) {
      return e.code.replace('Numpad', '');
    }
    if (
      e.code === 'Period' || 
      e.code === 'Comma' || 
      e.code === 'NumpadDecimal' || 
      e.key === '.' || 
      e.key === ',' || 
      e.key === 'б' || 
      e.key === 'Б' || 
      e.key === 'ю' || 
      e.key === 'Ю'
    ) {
      return '.';
    }
    return '';
  }

  function extractDigitFromKey(e) {
    const mode = settings.digitSeekMode || 'both';
    if (mode === 'disabled') return null;

    if ((mode === 'digits' || mode === 'both') && e.code.startsWith('Digit')) {
      const num = parseInt(e.code.replace('Digit', ''), 10);
      return !isNaN(num) ? num : null;
    }
    if ((mode === 'numpad' || mode === 'both') && e.code.startsWith('Numpad') && e.code.length === 7) {
      const num = parseInt(e.code.replace('Numpad', ''), 10);
      return !isNaN(num) ? num : null;
    }
    return null;
  }

  function isTimecodeModifierActive(e) {
    const mod = settings.timecodeModifier;
    if (!mod) return e.altKey;
    if (typeof mod === 'string') {
      if (mod === 'Alt') return e.altKey;
      if (mod === 'Control') return e.ctrlKey;
      if (mod === 'Shift') return e.shiftKey;
      return e.altKey;
    }
    return matchesCombo(e, mod);
  }

  function isInputFocused() {
    const activeEl = document.activeElement;
    if (!activeEl) return false;
    return activeEl.tagName === 'INPUT' || 
           activeEl.tagName === 'TEXTAREA' || 
           activeEl.isContentEditable || 
           activeEl.getAttribute('contenteditable') === 'true';
  }

  function resetSpeedInputTimer(media) {
    clearTimeout(speedInputTimer);
    speedInputTimer = setTimeout(() => {
      const parsedSpeed = parseFloat(speedInputBuffer);
      if (!isNaN(parsedSpeed)) {
        setMediaSpeed(media, parsedSpeed, true);
      }
      speedInputBuffer = "";
      isDirectInputActive = false;
    }, 1200);
  }

  function resetTimecodeTimer(media) {
    clearTimeout(timecodeTimer);
    timecodeTimer = setTimeout(() => {
      const totalSec = parseTimecodeBufferToSeconds(timecodeBuffer);
      if (media) {
        const duration = getMediaDuration(media);
        const targetTime = duration > 0 ? Math.min(duration, totalSec) : totalSec;
        seekTo(media, targetTime);

        const hrs = Math.floor(targetTime / 3600);
        const mins = Math.floor((targetTime % 3600) / 60);
        const secs = Math.floor(targetTime % 60);
        const formatted = hrs > 0 
          ? `${hrs}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`
          : `${mins}:${String(secs).padStart(2,'0')}`;

        showIndicator(`Переход: ${formatted}`);
      }
      timecodeBuffer = "";
      isTimecodeInputActive = false;
      hideTimecodeOverlay();
    }, 2000);
  }

  function handleMouseHotkey(e) {
    if (isInputFocused() && !isHoveringMediaOrPlayer()) return;

    const media = getActiveMedia();
    if (!media) return;

    const mouseCode = 'Mouse' + e.button;
    const { backSec, fwdSec } = getRewindSecs();

    // Отмена перемотки кнопкой мыши (перехватываем только пока отмена доступна)
    const undoCombo = settings.undoRewindCombo;
    if (
      undoState && undoCombo && undoCombo.code === mouseCode && !isFeatureDisabled('rewind') &&
      !!undoCombo.ctrl === e.ctrlKey && !!undoCombo.shift === e.shiftKey && !!undoCombo.alt === e.altKey
    ) {
      e.preventDefault();
      e.stopPropagation();
      undoLastSeek();
      return;
    }

    if (settings.codeRewindBack === mouseCode && !isFeatureDisabled('rewind')) {
      e.preventDefault();
      e.stopPropagation();
      handleRewind(media, backSec, 'back');
      return;
    }

    if (settings.codeRewindForward === mouseCode && !isFeatureDisabled('rewind')) {
      e.preventDefault();
      e.stopPropagation();
      handleRewind(media, fwdSec, 'forward');
      return;
    }

    if (settings.customRewindBinds && Array.isArray(settings.customRewindBinds) && !isFeatureDisabled('rewind')) {
      for (const bind of settings.customRewindBinds) {
        if (bind.combo && bind.combo.code === mouseCode) {
          if (
            bind.combo.ctrl === e.ctrlKey &&
            bind.combo.shift === e.shiftKey &&
            bind.combo.alt === e.altKey
          ) {
            e.preventDefault();
            e.stopPropagation();
            const secs = bind.seconds || 0;
            if (secs < 0) {
              handleRewind(media, Math.abs(secs), 'back');
            } else if (secs > 0) {
              handleRewind(media, secs, 'forward');
            }
            return;
          }
        }
      }
    }

    if (settings.customSpeedBinds && Array.isArray(settings.customSpeedBinds) && !isFeatureDisabled('speed')) {
      for (const bind of settings.customSpeedBinds) {
        if (bind.combo && bind.combo.code === mouseCode) {
          if (
            bind.combo.ctrl === e.ctrlKey &&
            bind.combo.shift === e.shiftKey &&
            bind.combo.alt === e.altKey
          ) {
            e.preventDefault();
            e.stopPropagation();
            setMediaSpeed(media, bind.speed, true);
            return;
          }
        }
      }
    }
  }

  window.addEventListener('auxclick', handleMouseHotkey, true);
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) {
      handleMouseHotkey(e);
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    const media = getActiveMedia();
    if (!media) return;

    if (isInputFocused()) {
      const hasModifier = e.ctrlKey || e.altKey || e.metaKey;
      if (!hasModifier && !isHoveringMediaOrPlayer()) {
        return;
      }
    }

    // Отмена перемотки: перехватываем сочетание, только если есть что отменять.
    // Иначе Ctrl+Z остаётся страничным (например, отмена ввода в текстовом поле).
    if (undoState && !isFeatureDisabled('rewind') && matchesUndoCombo(e)) {
      if (!isInputFocused() || isHoveringMediaOrPlayer()) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        undoLastSeek();
        return;
      }
    }

    if (isTimecodeInputActive) {
      if (e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        timecodeBuffer = timecodeBuffer.slice(0, -1);
        if (timecodeBuffer === "") {
          clearTimeout(timecodeTimer);
          isTimecodeInputActive = false;
          hideTimecodeOverlay();
        } else {
          updateTimecodeOverlay();
          resetTimecodeTimer(media);
        }
        return;
      }

      if (e.key === 'Delete' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        clearTimeout(timecodeTimer);
        timecodeBuffer = "";
        isTimecodeInputActive = false;
        hideTimecodeOverlay();
        return;
      }

      const digit = extractDigitFromKey(e);
      if (digit !== null) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        timecodeBuffer += String(digit);
        updateTimecodeOverlay();
        resetTimecodeTimer(media);
        return;
      }
    }

    const isModPressed = isTimecodeModifierActive(e);
    const digit = extractDigitFromKey(e);

    if (isModPressed && digit !== null && !isFeatureDisabled('timecode')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      isTimecodeInputActive = true;
      timecodeBuffer = String(digit);
      updateTimecodeOverlay();
      resetTimecodeTimer(media);
      return;
    }

    const frameBackCode = settings.codeFrameBack || 'Comma';
    const isFrameBack = (e.code === frameBackCode) || 
                       (frameBackCode.includes('Comma') && (e.code === 'Comma' || e.code === 'KeyComma' || e.key === 'б' || e.key === 'Б' || e.key === '<'));

    const frameForwardCode = settings.codeFrameForward || 'Period';
    const isFrameForward = (e.code === frameForwardCode) || 
                          (frameForwardCode.includes('Period') && (e.code === 'Period' || e.code === 'KeyPeriod' || e.key === 'ю' || e.key === 'Ю' || e.key === '>'));

    if ((isFrameBack || isFrameForward) && !isFeatureDisabled('rewind')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const frameStep = 1 / 30;
      if (isFrameBack) {
        seekTo(media, Math.max(0, media.currentTime - frameStep));
        showIndicator('Кадр назад');
      } else {
        const duration = getMediaDuration(media);
        seekTo(media, Math.min(duration || Infinity, media.currentTime + frameStep));
        showIndicator('Кадр вперед');
      }
      return;
    }

    if (settings.customRewindBinds && Array.isArray(settings.customRewindBinds) && !isFeatureDisabled('rewind')) {
      for (const bind of settings.customRewindBinds) {
        if (matchesCombo(e, bind.combo)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const secs = bind.seconds || 0;
          if (secs < 0) {
            handleRewind(media, Math.abs(secs), 'back');
          } else if (secs > 0) {
            handleRewind(media, secs, 'forward');
          }
          return;
        }
      }
    }

    if (settings.customSpeedBinds && Array.isArray(settings.customSpeedBinds) && !isFeatureDisabled('speed')) {
      for (const bind of settings.customSpeedBinds) {
        if (matchesCombo(e, bind.combo)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setMediaSpeed(media, bind.speed, true);
          return;
        }
      }
    }

    const mainCombo = settings.directInputCombo || { ctrl: true, shift: true, alt: false, code: '' };

    if (!isDirectInputActive && matchesCombo(e, mainCombo) && !isFeatureDisabled('speed')) {
      const char = convertCodeToChar(e);
      if (char !== '' && char !== '.') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        isDirectInputActive = true;
        speedInputBuffer = char;
        showIndicator(`Ввод: ${speedInputBuffer}x`);
        resetSpeedInputTimer(media);
        return;
      }
    }

    if (isDirectInputActive && !isFeatureDisabled('speed')) {
      const char = convertCodeToChar(e);
      if (char !== '') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (char === '.' && speedInputBuffer.includes('.')) return;
        speedInputBuffer += char;
        showIndicator(`Ввод: ${speedInputBuffer}x`);
        resetSpeedInputTimer(media);
        return;
      }
    }

    const { backSec, fwdSec } = getRewindSecs();

    if (e.code === settings.codeRewindBack && !isFeatureDisabled('rewind')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      handleRewind(media, backSec, 'back');
      return;
    } else if (e.code === settings.codeRewindForward && !isFeatureDisabled('rewind')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      handleRewind(media, fwdSec, 'forward');
      return;
    }

    if (!isModPressed && digit !== null && !isFeatureDisabled('digits')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const percent = digit * 10;
      const duration = getMediaDuration(media);
      if (duration > 0) {
        seekTo(media, (duration * percent) / 100);
        showIndicator(`Перемотано на ${percent}%`);
      } else if (media.duration && isFinite(media.duration)) {
        seekTo(media, (media.duration * percent) / 100);
        showIndicator(`Перемотано на ${percent}%`);
      }
      return;
    }
  }, true);
})();
