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

  const defaultSettings = {
    showIndicatorOnLoad: false,
    speedStep: 0.1,
    minSpeed: 0.1,
    maxSpeed: 16.0,
    rewindBackSec: 10,
    rewindForwardSec: 10,
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
    posNormal: 'top-center',
    posFullscreen: 'top-center',
    blacklist: [],
    siteSpeeds: {}
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

  if (isExtensionValid()) {
    try {
      chrome.storage?.onChanged?.addListener((changes) => {
        if (!isExtensionValid()) return;
        for (const key in changes) {
          settings[key] = changes[key].newValue;
        }
      });
    } catch (e) {}

    try {
      chrome.runtime?.onMessage?.addListener((request) => {
        if (!isExtensionValid()) return;
        if (request.action === 'setSpeed' && !isFeatureDisabled('speed')) {
          const media = getActiveMedia();
          if (media) {
            setMediaSpeed(media, request.speed, true);
          }
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
      fontFamily: 'monospace, sans-serif',
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
      fontFamily: 'system-ui, sans-serif',
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

  function handleRewind(media, seconds, direction) {
    if (!media || isFeatureDisabled('rewind')) return;

    const delta = direction === 'forward' ? seconds : -seconds;

    if ((direction === 'forward' && rewindAccumulator < 0) || (direction === 'back' && rewindAccumulator > 0)) {
      rewindAccumulator = 0;
    }

    rewindAccumulator += delta;
    const duration = getMediaDuration(media);

    if (direction === 'forward') {
      media.currentTime = Math.min(duration || Infinity, media.currentTime + seconds);
    } else {
      media.currentTime = Math.max(0, media.currentTime - seconds);
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
      fontFamily: 'Consolas, Monaco, monospace',
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
    if (isFeatureDisabled('speed')) return;

    const minS = 0.1;
    const maxS = 16.0;

    let clampedSpeed = Math.min(maxS, Math.max(minS, parseFloat(newSpeed)));
    clampedSpeed = Math.round(clampedSpeed * 100) / 100;

    forceSetSpeed(media, clampedSpeed);
    saveSpeed(clampedSpeed);

    if (showUI) {
      const pauseLabel = media.paused ? ' (Пауза)' : '';
      showIndicator(`${clampedSpeed.toFixed(2)}x${pauseLabel}`);
    }
  }

  function attachMediaListeners(media) {
    if (media.dataset.speedControlAttached) return;
    media.dataset.speedControlAttached = "true";

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
      const step = parseFloat(settings.speedStep);

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

      setMediaSpeed(media, 1.0, true);
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
        media.currentTime = targetTime;

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
        media.currentTime = Math.max(0, media.currentTime - frameStep);
        showIndicator('Кадр назад');
      } else {
        const duration = getMediaDuration(media);
        media.currentTime = Math.min(duration || Infinity, media.currentTime + frameStep);
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
        media.currentTime = (duration * percent) / 100;
        showIndicator(`Перемотано на ${percent}%`);
      } else if (media.duration && isFinite(media.duration)) {
        media.currentTime = (media.duration * percent) / 100;
        showIndicator(`Перемотано на ${percent}%`);
      }
      return;
    }
  }, true);
})();