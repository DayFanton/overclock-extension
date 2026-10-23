// Важно: siteSpeeds и siteVolumes сюда не добавляем. Их пишет content.js, а popup
// сохраняет весь этот объект целиком и мог бы затереть их устаревшими значениями.
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
  blacklist: []
};

// Встроенные шрифты. Список должен совпадать со списком в content.js
const BUILTIN_FONTS = [
  { id: 'default', label: 'Стандартный', stack: '' },
  { id: 'system', label: 'Системный', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { id: 'arial', label: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
  { id: 'verdana', label: 'Verdana', stack: 'Verdana, Geneva, sans-serif' },
  { id: 'tahoma', label: 'Tahoma', stack: 'Tahoma, Geneva, sans-serif' },
  { id: 'trebuchet', label: 'Trebuchet MS', stack: "'Trebuchet MS', Helvetica, sans-serif" },
  { id: 'georgia', label: 'Georgia', stack: "Georgia, 'Times New Roman', serif" },
  { id: 'times', label: 'Times New Roman', stack: "'Times New Roman', Times, serif" },
  { id: 'mono', label: 'Моноширинный (Consolas)', stack: "Consolas, Monaco, 'Courier New', monospace" },
  { id: 'courier', label: 'Courier New', stack: "'Courier New', Courier, monospace" }
];

// Свои шрифты лежат в chrome.storage.local: список в customFontsMeta,
// сами файлы (base64) отдельными ключами customFont_<id>
const FONT_KEY_PREFIX = 'customFont_';
const MAX_FONT_FILE_BYTES = 2 * 1024 * 1024;
const FONT_HINT_DEFAULT = 'TTF, OTF, WOFF или WOFF2, до 2 МБ. Шрифт применяется к этому меню и к плашкам на странице.';

let currentSettings = { ...defaultSettings };
let tempCustomBinds = [];
let tempCustomRewindBinds = [];
let tempBlacklist = [];
let activeSection = 'general';

let customFonts = []; // [{ id, name }]
const uiFontFaces = new Map(); // id -> FontFace (шрифты, уже добавленные в это окно)
let uiFontToken = 0;
let fontHintTimer = null;
let pageHost = ''; // сайт активной вкладки (для подписи под ползунком громкости)

document.addEventListener('DOMContentLoaded', async () => {
  const tabs = document.querySelectorAll('.tab-btn');
  const contents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetSection = tab.dataset.tab;
      if (activeSection === targetSection) return;

      if (hasUnsavedChanges(activeSection)) {
        showUnsavedPrompt(
          () => {
            saveSection(activeSection);
            switchTab(targetSection);
          },
          () => {
            loadSettingsToUI(currentSettings);
            switchTab(targetSection);
          }
        );
      } else {
        switchTab(targetSection);
      }
    });
  });

  function switchTab(section) {
    activeSection = section;
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === section));
    contents.forEach(c => c.classList.toggle('active', c.id === `tab-${section}`));
    hideUnsavedPrompt();
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    const stored = await chrome.storage.local.get(defaultSettings);
    currentSettings = { ...defaultSettings, ...stored };
    // Мин. и макс. скорость убраны из настроек: чистим старые значения
    chrome.storage.local.remove(['minSpeed', 'maxSpeed']);
  }

  await initFontControls();
  loadSettingsToUI(currentSettings);

  document.getElementById('infoBtn')?.addEventListener('click', () => {
    document.getElementById('infoModal').style.display = 'flex';
  });

  document.getElementById('closeInfoBtn')?.addEventListener('click', () => {
    document.getElementById('infoModal').style.display = 'none';
  });

  document.getElementById('applyCurrentSpeedBtn')?.addEventListener('click', applyCurrentSpeed);
  document.getElementById('directSetSpeed')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyCurrentSpeed();
  });

  const volumeSlider = document.getElementById('volumeBoost');
  volumeSlider?.addEventListener('input', async () => {
    const percent = parseInt(volumeSlider.value, 10) || 100;
    document.getElementById('volumeBoostValue').textContent = `${percent}%`;
    const res = await sendToActiveTab({ action: 'setVolumeBoost', boost: percent / 100 });
    updateVolumeUi(undefined, res ? res.volumeStatus : 'none');
  });

  // Показываем настоящую скорость и усиление громкости видео на странице
  refreshPageState();

  setupKeyInput('directInputCombo', true);
  setupKeyInput('timecodeModifier', true);
  setupKeyInput('codeRewindBack', false);
  setupKeyInput('codeRewindForward', false);
  setupKeyInput('codeFrameBack', false);
  setupKeyInput('codeFrameForward', false);
  setupKeyInput('undoRewindCombo', true, true);

  const bgOpacityInput = document.getElementById('bgOpacity');
  const bgOpacityValue = document.getElementById('bgOpacityValue');
  bgOpacityInput?.addEventListener('input', () => {
    bgOpacityValue.textContent = `${Math.round(bgOpacityInput.value * 100)}%`;
    checkChangesOnInput();
  });

  document.getElementById('addCustomBindBtn')?.addEventListener('click', () => {
    tempCustomBinds.push({
      combo: { ctrl: false, shift: false, alt: false, code: 'KeyZ' },
      speed: 2.0
    });
    renderCustomBinds();
    checkChangesOnInput();
  });

  document.getElementById('addCustomRewindBindBtn')?.addEventListener('click', () => {
    tempCustomRewindBinds.push({
      combo: { ctrl: false, shift: false, alt: false, code: 'KeyK' },
      seconds: -5
    });
    renderCustomRewindBinds();
    checkChangesOnInput();
  });

  document.getElementById('addDomainBtn')?.addEventListener('click', () => {
    const input = document.getElementById('addDomainInput');
    const rawDomain = input.value.trim().toLowerCase();
    if (rawDomain) {
      const cleanDomain = rawDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!tempBlacklist.some(x => x.domain === cleanDomain)) {
        tempBlacklist.push({
          domain: cleanDomain,
          enabledFeatures: { speed: true, rewind: true, digits: true, timecode: true, volume: true }
        });
        input.value = '';
        renderBlacklist();
        checkChangesOnInput();
      }
    }
  });

  document.querySelectorAll('input, select, textarea').forEach(el => {
    el.addEventListener('input', checkChangesOnInput);
    el.addEventListener('change', checkChangesOnInput);
  });

  document.querySelectorAll('button[data-save]').forEach(btn => {
    btn.addEventListener('click', (e) => saveSection(e.target.dataset.save, e.target));
  });

  document.querySelectorAll('button[data-reset]').forEach(btn => {
    btn.addEventListener('click', (e) => resetSection(e.target.dataset.reset));
  });

  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges(activeSection)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
});

function normalizeTimecodeCombo(val) {
  if (typeof val === 'string') {
    if (val === 'Alt') return { ctrl: false, shift: false, alt: true, code: '' };
    if (val === 'Control') return { ctrl: true, shift: false, alt: false, code: '' };
    if (val === 'Shift') return { ctrl: false, shift: true, alt: false, code: '' };
  }
  if (val && typeof val === 'object') return val;
  return { ctrl: false, shift: false, alt: true, code: '' };
}

// Для отмены перемотки обязательна конкретная клавиша (одних модификаторов мало)
function normalizeUndoCombo(val) {
  if (val && typeof val === 'object' && typeof val.code === 'string' && val.code) {
    return { ctrl: !!val.ctrl, shift: !!val.shift, alt: !!val.alt, code: val.code };
  }
  return { ...defaultSettings.undoRewindCombo };
}

function parseUndoDelay(raw) {
  const value = parseFloat(raw);
  if (!isFinite(value) || value < 0) return defaultSettings.undoRewindDelaySec;
  return Math.min(30, Math.round(value * 10) / 10);
}

function parseResetSpeed(raw) {
  const value = parseFloat(raw);
  if (!isFinite(value) || value <= 0) return defaultSettings.resetSpeed;
  return Math.min(16, Math.max(0.1, Math.round(value * 100) / 100));
}

function normalizeBlacklist(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList.map(item => {
    if (typeof item === 'string') {
      return {
        domain: item,
        enabledFeatures: { speed: false, rewind: false, digits: false, timecode: false, volume: false }
      };
    }
    let enabled = {};
    if (item.enabledFeatures) {
      enabled = {
        speed: item.enabledFeatures.speed !== false,
        rewind: item.enabledFeatures.rewind !== false,
        digits: item.enabledFeatures.digits !== false,
        timecode: item.enabledFeatures.timecode !== false,
        volume: item.enabledFeatures.volume !== false
      };
    } else {
      enabled = { speed: true, rewind: true, digits: true, timecode: true, volume: true };
    }
    return {
      domain: item.domain || '',
      enabledFeatures: enabled
    };
  }).filter(item => item.domain.trim() !== '');
}

function checkChangesOnInput() {
  if (hasUnsavedChanges(activeSection)) {
    showUnsavedPrompt(
      () => saveSection(activeSection),
      () => loadSettingsToUI(currentSettings)
    );
  } else {
    hideUnsavedPrompt();
  }
}

function hasUnsavedChanges(section) {
  if (section === 'general') {
    return (
      document.getElementById('showIndicatorOnLoad')?.checked !== currentSettings.showIndicatorOnLoad ||
      document.getElementById('digitSeekMode')?.value !== (currentSettings.digitSeekMode || 'both') ||
      parseFloat(document.getElementById('step')?.value) !== currentSettings.speedStep ||
      parseResetSpeed(document.getElementById('resetSpeed')?.value) !== parseResetSpeed(currentSettings.resetSpeed) ||
      parseInt(document.getElementById('rewindBackSec')?.value, 10) !== currentSettings.rewindBackSec ||
      parseInt(document.getElementById('rewindForwardSec')?.value, 10) !== currentSettings.rewindForwardSec
    );
  } else if (section === 'hotkeys') {
    const directComboStr = document.getElementById('directInputCombo')?.dataset.combo;
    const currentCombo = directComboStr ? JSON.parse(directComboStr) : currentSettings.directInputCombo;

    const timecodeComboStr = document.getElementById('timecodeModifier')?.dataset.combo;
    const currentTcCombo = timecodeComboStr ? JSON.parse(timecodeComboStr) : normalizeTimecodeCombo(currentSettings.timecodeModifier);

    const backCode = document.getElementById('codeRewindBack')?.dataset.code || currentSettings.codeRewindBack;
    const fwdCode = document.getElementById('codeRewindForward')?.dataset.code || currentSettings.codeRewindForward;
    const frameBackCode = document.getElementById('codeFrameBack')?.dataset.code || currentSettings.codeFrameBack;
    const frameFwdCode = document.getElementById('codeFrameForward')?.dataset.code || currentSettings.codeFrameForward;

    const undoComboStr = document.getElementById('undoRewindCombo')?.dataset.combo;
    const currentUndoCombo = normalizeUndoCombo(undoComboStr ? JSON.parse(undoComboStr) : currentSettings.undoRewindCombo);

    return (
      JSON.stringify(currentUndoCombo) !== JSON.stringify(normalizeUndoCombo(currentSettings.undoRewindCombo)) ||
      parseUndoDelay(document.getElementById('undoRewindDelaySec')?.value) !== parseUndoDelay(currentSettings.undoRewindDelaySec) ||
      JSON.stringify(currentCombo) !== JSON.stringify(currentSettings.directInputCombo) ||
      JSON.stringify(currentTcCombo) !== JSON.stringify(normalizeTimecodeCombo(currentSettings.timecodeModifier)) ||
      backCode !== currentSettings.codeRewindBack ||
      fwdCode !== currentSettings.codeRewindForward ||
      frameBackCode !== (currentSettings.codeFrameBack || 'Comma') ||
      frameFwdCode !== (currentSettings.codeFrameForward || 'Period') ||
      JSON.stringify(tempCustomBinds) !== JSON.stringify(currentSettings.customSpeedBinds || []) ||
      JSON.stringify(tempCustomRewindBinds) !== JSON.stringify(currentSettings.customRewindBinds || [])
    );
  } else if (section === 'design') {
    const hexBg = document.getElementById('bgColor')?.value || '#000000';
    const opacity = document.getElementById('bgOpacity')?.value || '0.85';
    const rgb = hexToRgb(hexBg);
    const newRgba = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})` : currentSettings.bgColorRgba;

    return (
      document.getElementById('textColor')?.value !== currentSettings.textColor ||
      newRgba !== currentSettings.bgColorRgba ||
      parseInt(document.getElementById('fontSize')?.value, 10) !== currentSettings.fontSize ||
      document.getElementById('fontFamily')?.value !== (currentSettings.fontFamily || 'default') ||
      document.getElementById('posNormal')?.value !== currentSettings.posNormal ||
      document.getElementById('posFullscreen')?.value !== currentSettings.posFullscreen
    );
  } else if (section === 'blacklist') {
    return JSON.stringify(tempBlacklist) !== JSON.stringify(normalizeBlacklist(currentSettings.blacklist));
  }
  return false;
}

function comboToString(combo) {
  if (!combo) return 'Нажмите клавишу';
  if (typeof combo === 'string') return formatCodeString(combo);

  const parts = [];
  if (combo.ctrl) parts.push('Ctrl');
  if (combo.shift) parts.push('Shift');
  if (combo.alt) parts.push('Alt');
  if (combo.code) parts.push(formatCodeString(combo.code));

  return parts.length > 0 ? parts.join(' + ') : 'Нажмите клавишу';
}

function formatCodeString(code) {
  if (!code) return '';
  if (code.startsWith('Mouse')) return 'Мышь ' + code.replace('Mouse', '');
  if (code === 'KeyComma' || code === 'Comma') return '<';
  if (code === 'KeyPeriod' || code === 'Period') return '>';
  return code.replace('Key', '').replace('Digit', '').replace('Numpad', 'Num ');
}

// requireCode: сочетание принимается только вместе с конкретной клавишей или кнопкой мыши
// (одних Ctrl/Shift/Alt мало). Левый клик мимо поля отменяет запись.
function setupKeyInput(elementId, isComboObject, requireCode = false) {
  const input = document.getElementById(elementId);
  if (!input) return;

  input.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (input.classList.contains('recording')) return;

    const previousValue = input.value;
    input.value = 'Нажмите...';
    input.classList.add('recording');

    let capturedCombo = { ctrl: false, shift: false, alt: false, code: '' };

    const cleanup = () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('auxclick', handleMouseDown, true);
      window.removeEventListener('contextmenu', preventContext, true);
      input.classList.remove('recording');
    };

    const preventContext = (ev) => ev.preventDefault();

    const updateUI = () => {
      if (isComboObject) {
        if (!requireCode || capturedCombo.code) {
          input.dataset.combo = JSON.stringify(capturedCombo);
        }
        input.value = comboToString(capturedCombo);
      } else {
        input.dataset.code = capturedCombo.code;
        input.value = formatCodeString(capturedCombo.code);
      }
    };

    const handleMouseDown = (ev) => {
      if (ev.target === input && ev.button === 0 && input.value === 'Нажмите...') {
        return;
      }
      if (requireCode && ev.button === 0) {
        // Левый клик мимо поля отменяет запись и возвращает прежнее значение
        input.value = previousValue;
        cleanup();
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();

      capturedCombo.ctrl = ev.ctrlKey;
      capturedCombo.shift = ev.shiftKey;
      capturedCombo.alt = ev.altKey;
      capturedCombo.code = 'Mouse' + ev.button;

      updateUI();
      cleanup();
      checkChangesOnInput();
    };

    const handleKeyDown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const isMod = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(ev.code) || ['Control', 'Shift', 'Alt', 'Meta'].includes(ev.key);

      capturedCombo.ctrl = ev.ctrlKey;
      capturedCombo.shift = ev.shiftKey;
      capturedCombo.alt = ev.altKey;

      if (!isMod) {
        capturedCombo.code = ev.code;
        updateUI();
        cleanup();
        checkChangesOnInput();
      } else {
        capturedCombo.code = '';
        updateUI();
      }
    };

    const handleKeyUp = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (isComboObject && !requireCode && (capturedCombo.ctrl || capturedCombo.shift || capturedCombo.alt)) {
        updateUI();
        cleanup();
        checkChangesOnInput();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('auxclick', handleMouseDown, true);
    window.addEventListener('contextmenu', preventContext, true);
  });
}

function setupCustomBindKeyInput(keyInput, bind) {
  keyInput.addEventListener('click', (e) => {
    e.preventDefault();
    keyInput.value = 'Нажмите...';
    keyInput.classList.add('recording');

    let capturedCombo = { ctrl: false, shift: false, alt: false, code: '' };

    const cleanup = () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('auxclick', handleMouseDown, true);
      window.removeEventListener('contextmenu', preventContext, true);
      keyInput.classList.remove('recording');
    };

    const preventContext = (ev) => ev.preventDefault();

    const handleMouseDown = (ev) => {
      if (ev.target === keyInput && ev.button === 0 && keyInput.value === 'Нажмите...') return;
      ev.preventDefault();
      ev.stopPropagation();

      capturedCombo.ctrl = ev.ctrlKey;
      capturedCombo.shift = ev.shiftKey;
      capturedCombo.alt = ev.altKey;
      capturedCombo.code = 'Mouse' + ev.button;

      bind.combo = capturedCombo;
      keyInput.value = comboToString(bind.combo);
      cleanup();
      checkChangesOnInput();
    };

    const handleKeyDown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const isMod = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(ev.code) || ['Control', 'Shift', 'Alt', 'Meta'].includes(ev.key);

      capturedCombo.ctrl = ev.ctrlKey;
      capturedCombo.shift = ev.shiftKey;
      capturedCombo.alt = ev.altKey;

      if (!isMod) {
        capturedCombo.code = ev.code;
        bind.combo = capturedCombo;
        keyInput.value = comboToString(bind.combo);
        cleanup();
        checkChangesOnInput();
      } else {
        capturedCombo.code = '';
        keyInput.value = comboToString(capturedCombo);
      }
    };

    const handleKeyUp = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (capturedCombo.ctrl || capturedCombo.shift || capturedCombo.alt) {
        bind.combo = capturedCombo;
        keyInput.value = comboToString(bind.combo);
        cleanup();
        checkChangesOnInput();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('auxclick', handleMouseDown, true);
    window.addEventListener('contextmenu', preventContext, true);
  });
}

function renderCustomBinds() {
  const container = document.getElementById('customBindsList');
  if (!container) return;
  container.innerHTML = '';

  tempCustomBinds.forEach((bind, index) => {
    const item = document.createElement('div');
    item.className = 'custom-bind-item';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'key-input';
    keyInput.readOnly = true;
    keyInput.value = comboToString(bind.combo);

    setupCustomBindKeyInput(keyInput, bind);

    const speedInput = document.createElement('input');
    speedInput.type = 'number';
    speedInput.className = 'speed-input';
    speedInput.step = '0.1';
    speedInput.value = bind.speed;
    speedInput.addEventListener('change', (e) => {
      bind.speed = parseFloat(e.target.value) || 1.0;
      checkChangesOnInput();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-icon';
    delBtn.innerText = '✕';
    delBtn.addEventListener('click', () => {
      tempCustomBinds.splice(index, 1);
      renderCustomBinds();
      checkChangesOnInput();
    });

    item.appendChild(keyInput);
    item.appendChild(speedInput);
    item.appendChild(delBtn);
    container.appendChild(item);
  });
}

function renderCustomRewindBinds() {
  const container = document.getElementById('customRewindBindsList');
  if (!container) return;
  container.innerHTML = '';

  tempCustomRewindBinds.forEach((bind, index) => {
    const item = document.createElement('div');
    item.className = 'custom-bind-item';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'key-input';
    keyInput.readOnly = true;
    keyInput.value = comboToString(bind.combo);

    setupCustomBindKeyInput(keyInput, bind);

    const secInput = document.createElement('input');
    secInput.type = 'number';
    secInput.className = 'speed-input';
    secInput.placeholder = 'сек';
    secInput.value = bind.seconds;
    secInput.addEventListener('change', (e) => {
      bind.seconds = parseInt(e.target.value, 10) || 0;
      checkChangesOnInput();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-icon';
    delBtn.innerText = '✕';
    delBtn.addEventListener('click', () => {
      tempCustomRewindBinds.splice(index, 1);
      renderCustomRewindBinds();
      checkChangesOnInput();
    });

    item.appendChild(keyInput);
    item.appendChild(secInput);
    item.appendChild(delBtn);
    container.appendChild(item);
  });
}

function renderBlacklist() {
  const container = document.getElementById('blacklistContainer');
  if (!container) return;
  container.innerHTML = '';

  if (tempBlacklist.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 11px; padding: 12px;">Черный список пуст</div>`;
    return;
  }

  tempBlacklist.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'domain-card';

    const header = document.createElement('div');
    header.className = 'domain-card-header';
    header.innerHTML = `<span>${item.domain}</span>`;

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-icon';
    delBtn.innerText = '✕';
    delBtn.title = 'Удалить домен';
    delBtn.addEventListener('click', () => {
      showCustomConfirm(`Удалить ${item.domain} из черного списка?`, () => {
        tempBlacklist.splice(index, 1);
        renderBlacklist();
        checkChangesOnInput();
      });
    });

    header.appendChild(delBtn);
    card.appendChild(header);

    const featuresDiv = document.createElement('div');
    featuresDiv.className = 'domain-features';

    const features = [
      { key: 'digits', label: 'Перемотка цифрами' },
      { key: 'speed', label: 'Изменение скорости' },
      { key: 'rewind', label: 'Перемотка (J/L)' },
      { key: 'timecode', label: 'Ввод таймкода' },
      { key: 'volume', label: 'Усиление громкости' }
    ];

    features.forEach(f => {
      const lbl = document.createElement('label');
      lbl.className = 'domain-feature-label';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = item.enabledFeatures[f.key] !== false;
      chk.addEventListener('change', () => {
        item.enabledFeatures[f.key] = chk.checked;
        checkChangesOnInput();
      });

      lbl.appendChild(chk);
      lbl.appendChild(document.createTextNode(f.label));
      featuresDiv.appendChild(lbl);
    });

    card.appendChild(featuresDiv);
    container.appendChild(card);
  });
}

function loadSettingsToUI(s) {
  if (document.getElementById('showIndicatorOnLoad')) {
    document.getElementById('showIndicatorOnLoad').checked = s.showIndicatorOnLoad;
  }
  if (document.getElementById('digitSeekMode')) {
    document.getElementById('digitSeekMode').value = s.digitSeekMode || 'both';
  }
  if (document.getElementById('step')) document.getElementById('step').value = s.speedStep;
  if (document.getElementById('resetSpeed')) {
    document.getElementById('resetSpeed').value = parseResetSpeed(s.resetSpeed);
  }

  if (document.getElementById('rewindBackSec')) {
    document.getElementById('rewindBackSec').value = s.rewindBackSec;
  }
  if (document.getElementById('rewindForwardSec')) {
    document.getElementById('rewindForwardSec').value = s.rewindForwardSec;
  }

  const directInputEl = document.getElementById('directInputCombo');
  if (directInputEl) {
    directInputEl.dataset.combo = JSON.stringify(s.directInputCombo);
    directInputEl.value = comboToString(s.directInputCombo);
  }

  const tcCombo = normalizeTimecodeCombo(s.timecodeModifier);
  const timecodeEl = document.getElementById('timecodeModifier');
  if (timecodeEl) {
    timecodeEl.dataset.combo = JSON.stringify(tcCombo);
    timecodeEl.value = comboToString(tcCombo);
  }

  const backEl = document.getElementById('codeRewindBack');
  if (backEl) {
    backEl.dataset.code = s.codeRewindBack;
    backEl.value = formatCodeString(s.codeRewindBack);
  }

  const fwdEl = document.getElementById('codeRewindForward');
  if (fwdEl) {
    fwdEl.dataset.code = s.codeRewindForward;
    fwdEl.value = formatCodeString(s.codeRewindForward);
  }

  const frameBackEl = document.getElementById('codeFrameBack');
  if (frameBackEl) {
    frameBackEl.dataset.code = s.codeFrameBack || 'Comma';
    frameBackEl.value = formatCodeString(s.codeFrameBack || 'Comma');
  }

  const frameFwdEl = document.getElementById('codeFrameForward');
  if (frameFwdEl) {
    frameFwdEl.dataset.code = s.codeFrameForward || 'Period';
    frameFwdEl.value = formatCodeString(s.codeFrameForward || 'Period');
  }

  const undoEl = document.getElementById('undoRewindCombo');
  if (undoEl) {
    const undoCombo = normalizeUndoCombo(s.undoRewindCombo);
    undoEl.dataset.combo = JSON.stringify(undoCombo);
    undoEl.value = comboToString(undoCombo);
  }

  const undoDelayEl = document.getElementById('undoRewindDelaySec');
  if (undoDelayEl) {
    undoDelayEl.value = parseUndoDelay(s.undoRewindDelaySec);
  }

  tempCustomBinds = JSON.parse(JSON.stringify(s.customSpeedBinds || []));
  renderCustomBinds();

  tempCustomRewindBinds = JSON.parse(JSON.stringify(s.customRewindBinds || []));
  renderCustomRewindBinds();

  tempBlacklist = normalizeBlacklist(s.blacklist);
  renderBlacklist();

  let opacity = 0.85;
  if (s.bgColorRgba && s.bgColorRgba.startsWith('rgba')) {
    const match = s.bgColorRgba.match(/rgba?\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/);
    if (match) opacity = parseFloat(match[1]);
  }

  if (document.getElementById('textColor')) {
    document.getElementById('textColor').value = s.textColor || '#ffffff';
  }
  if (document.getElementById('bgColor')) {
    document.getElementById('bgColor').value = rgbaToHex(s.bgColorRgba);
  }
  if (document.getElementById('bgOpacity')) {
    document.getElementById('bgOpacity').value = opacity;
  }
  if (document.getElementById('bgOpacityValue')) {
    document.getElementById('bgOpacityValue').textContent = `${Math.round(opacity * 100)}%`;
  }
  if (document.getElementById('fontSize')) {
    document.getElementById('fontSize').value = s.fontSize;
  }
  const fontSelect = document.getElementById('fontFamily');
  if (fontSelect) {
    const wantedFont = s.fontFamily || 'default';
    const fontExists = Array.from(fontSelect.options).some(o => o.value === wantedFont);
    fontSelect.value = fontExists ? wantedFont : 'default';
    applyUiFont(fontSelect.value);
    updateDeleteFontBtn();
  }
  if (document.getElementById('posNormal')) {
    document.getElementById('posNormal').value = s.posNormal;
  }
  if (document.getElementById('posFullscreen')) {
    document.getElementById('posFullscreen').value = s.posFullscreen;
  }

  hideUnsavedPrompt();
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

function rgbaToHex(rgba) {
  if (!rgba) return '#000000';
  const match = rgba.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return '#000000';
  const r = parseInt(match[1]).toString(16).padStart(2, '0');
  const g = parseInt(match[2]).toString(16).padStart(2, '0');
  const b = parseInt(match[3]).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

function saveSection(section, btnElement) {
  const btn = btnElement || document.querySelector(`#tab-${section} button[data-save]`);

  if (section === 'general') {
    currentSettings.showIndicatorOnLoad = document.getElementById('showIndicatorOnLoad')?.checked ?? false;
    currentSettings.digitSeekMode = document.getElementById('digitSeekMode')?.value || 'both';
    currentSettings.speedStep = parseFloat(document.getElementById('step')?.value) || 0.1;
    currentSettings.resetSpeed = parseResetSpeed(document.getElementById('resetSpeed')?.value);
    currentSettings.rewindBackSec = parseInt(document.getElementById('rewindBackSec')?.value, 10) || 10;
    currentSettings.rewindForwardSec = parseInt(document.getElementById('rewindForwardSec')?.value, 10) || 10;
  } else if (section === 'hotkeys') {
    const directComboStr = document.getElementById('directInputCombo')?.dataset.combo;
    if (directComboStr) currentSettings.directInputCombo = JSON.parse(directComboStr);

    const tcComboStr = document.getElementById('timecodeModifier')?.dataset.combo;
    if (tcComboStr) currentSettings.timecodeModifier = JSON.parse(tcComboStr);

    currentSettings.codeRewindBack = document.getElementById('codeRewindBack')?.dataset.code || 'KeyJ';
    currentSettings.codeRewindForward = document.getElementById('codeRewindForward')?.dataset.code || 'KeyL';
    currentSettings.codeFrameBack = document.getElementById('codeFrameBack')?.dataset.code || 'Comma';
    currentSettings.codeFrameForward = document.getElementById('codeFrameForward')?.dataset.code || 'Period';

    const undoComboStr = document.getElementById('undoRewindCombo')?.dataset.combo;
    currentSettings.undoRewindCombo = normalizeUndoCombo(undoComboStr ? JSON.parse(undoComboStr) : currentSettings.undoRewindCombo);
    currentSettings.undoRewindDelaySec = parseUndoDelay(document.getElementById('undoRewindDelaySec')?.value);

    currentSettings.customSpeedBinds = JSON.parse(JSON.stringify(tempCustomBinds));
    currentSettings.customRewindBinds = JSON.parse(JSON.stringify(tempCustomRewindBinds));
  } else if (section === 'design') {
    currentSettings.textColor = document.getElementById('textColor')?.value || '#ffffff';
    const hexBg = document.getElementById('bgColor')?.value || '#000000';
    const opacity = document.getElementById('bgOpacity')?.value || '0.85';
    const rgb = hexToRgb(hexBg);

    if (rgb) {
      currentSettings.bgColorRgba = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
    }

    currentSettings.fontSize = parseInt(document.getElementById('fontSize')?.value, 10) || 16;
    currentSettings.fontFamily = document.getElementById('fontFamily')?.value || 'default';
    currentSettings.posNormal = document.getElementById('posNormal')?.value || 'top-center';
    currentSettings.posFullscreen = document.getElementById('posFullscreen')?.value || 'top-center';
  } else if (section === 'blacklist') {
    currentSettings.blacklist = JSON.parse(JSON.stringify(tempBlacklist));
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set(currentSettings, () => {
      showSaveIndicator(btn);
      hideUnsavedPrompt();
    });
  } else {
    showSaveIndicator(btn);
    hideUnsavedPrompt();
  }
}

function showSaveIndicator(btn) {
  if (!btn) return;
  const originalText = btn.innerText;
  const originalBg = btn.style.background;

  btn.innerText = 'Сохранено!';
  btn.style.background = '#10b981';

  setTimeout(() => {
    btn.innerText = originalText;
    btn.style.background = originalBg;
  }, 1200);
}

function showUnsavedPrompt(onSave, onDiscard) {
  let promptBar = document.getElementById('unsavedPromptBar');
  if (!promptBar) {
    promptBar = document.createElement('div');
    promptBar.id = 'unsavedPromptBar';
    promptBar.style.cssText = `
      position: fixed;
      bottom: 10px;
      left: 10px;
      right: 10px;
      background: var(--card-bg, #1c1e24);
      border: 1px solid var(--accent, #3b82f6);
      border-radius: 8px;
      padding: 8px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 9998;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    `;

    promptBar.innerHTML = `
      <span style="font-size: 11px; color: var(--text, #f3f4f6); font-weight: 500;">Есть несохраненные изменения!</span>
      <div style="display: flex; gap: 6px;">
        <button id="unsavedDiscardBtn" style="
          padding: 4px 8px; background: transparent; border: 1px solid var(--border, #2e323b);
          color: var(--text-muted, #9ca3af); border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: 600;
        ">Сбросить</button>
        <button id="unsavedSaveBtn" style="
          padding: 4px 8px; background: var(--accent, #3b82f6); border: none;
          color: white; border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: 600;
        ">Сохранить</button>
      </div>
    `;
    document.body.appendChild(promptBar);
  }

  promptBar.style.display = 'flex';

  const saveBtn = document.getElementById('unsavedSaveBtn');
  const discardBtn = document.getElementById('unsavedDiscardBtn');

  if (saveBtn) saveBtn.onclick = () => onSave();
  if (discardBtn) discardBtn.onclick = () => onDiscard();
}

function hideUnsavedPrompt() {
  const promptBar = document.getElementById('unsavedPromptBar');
  if (promptBar) {
    promptBar.style.display = 'none';
  }
}

function showCustomConfirm(message, onConfirm) {
  let modal = document.getElementById('customConfirmModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'customConfirmModal';
    modal.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      padding: 16px;
    `;

    modal.innerHTML = `
      <div style="
        background: var(--card-bg, #1c1e24);
        border: 1px solid var(--border, #2e323b);
        border-radius: 8px;
        padding: 16px;
        width: 100%;
        max-width: 280px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        text-align: center;
      ">
        <div id="customConfirmText" style="margin-bottom: 14px; font-size: 12px; color: var(--text, #f3f4f6); line-height: 1.4;"></div>
        <div style="display: flex; gap: 8px;">
          <button id="customConfirmCancel" style="
            flex: 1; padding: 7px; background: transparent; border: 1px solid var(--border, #2e323b);
            color: var(--text-muted, #9ca3af); border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600;
          ">Отмена</button>
          <button id="customConfirmOk" style="
            flex: 1; padding: 7px; background: var(--danger, #ef4444); border: none;
            color: white; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600;
          ">Подтвердить</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  document.getElementById('customConfirmText').innerText = message;
  modal.style.display = 'flex';

  const btnOk = document.getElementById('customConfirmOk');
  const btnCancel = document.getElementById('customConfirmCancel');

  const cleanup = () => {
    modal.style.display = 'none';
    if (btnOk) btnOk.onclick = null;
    if (btnCancel) btnCancel.onclick = null;
  };

  if (btnOk) {
    btnOk.onclick = () => {
      cleanup();
      onConfirm();
    };
  }

  if (btnCancel) {
    btnCancel.onclick = () => {
      cleanup();
    };
  }
}

function resetSection(section) {
  showCustomConfirm('Сбросить настройки этой вкладки по умолчанию?', () => {
    const btn = document.querySelector(`button[data-reset="${section}"]`);
    let originalText = '';

    if (btn) {
      originalText = btn.innerText;
      btn.disabled = true;
      btn.innerText = 'Сброс...';
      btn.style.opacity = '0.6';
      btn.style.cursor = 'wait';
    }

    setTimeout(() => {
      if (section === 'general') {
        currentSettings.showIndicatorOnLoad = defaultSettings.showIndicatorOnLoad;
        currentSettings.digitSeekMode = defaultSettings.digitSeekMode;
        currentSettings.speedStep = defaultSettings.speedStep;
        currentSettings.resetSpeed = defaultSettings.resetSpeed;
        currentSettings.rewindBackSec = defaultSettings.rewindBackSec;
        currentSettings.rewindForwardSec = defaultSettings.rewindForwardSec;
      } else if (section === 'hotkeys') {
        currentSettings.directInputCombo = defaultSettings.directInputCombo;
        currentSettings.timecodeModifier = defaultSettings.timecodeModifier;
        currentSettings.codeRewindBack = defaultSettings.codeRewindBack;
        currentSettings.codeRewindForward = defaultSettings.codeRewindForward;
        currentSettings.codeFrameBack = defaultSettings.codeFrameBack;
        currentSettings.codeFrameForward = defaultSettings.codeFrameForward;
        currentSettings.undoRewindCombo = { ...defaultSettings.undoRewindCombo };
        currentSettings.undoRewindDelaySec = defaultSettings.undoRewindDelaySec;
        currentSettings.customSpeedBinds = [];
        currentSettings.customRewindBinds = [];
      } else if (section === 'design') {
        currentSettings.textColor = defaultSettings.textColor;
        currentSettings.bgColorRgba = defaultSettings.bgColorRgba;
        currentSettings.fontSize = defaultSettings.fontSize;
        currentSettings.fontFamily = defaultSettings.fontFamily;
        currentSettings.posNormal = defaultSettings.posNormal;
        currentSettings.posFullscreen = defaultSettings.posFullscreen;
      } else if (section === 'blacklist') {
        currentSettings.blacklist = defaultSettings.blacklist;
      }

      const applyReset = () => {
        loadSettingsToUI(currentSettings);
        if (btn) {
          btn.disabled = false;
          btn.innerText = originalText;
          btn.style.opacity = '1';
          btn.style.cursor = 'pointer';
        }
      };

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(currentSettings, applyReset);
      } else {
        applyReset();
      }
    }, 1000);
  });
}

// ===== Связь с видео на активной вкладке =====

// Шлём сообщение content.js активной вкладки. Отвечает фрейм, в котором есть видео.
// Если ответа нет (служебная страница, нет видео), возвращаем null.
function sendToActiveTab(message) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return resolve(null);

    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      resolve(value);
    };
    setTimeout(() => finish(null), 2000);

    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || tab.id === undefined) return finish(null);
        chrome.tabs.sendMessage(tab.id, message, (response) => {
          void chrome.runtime.lastError; // читаем, чтобы Chrome не писал ошибку в консоль
          finish(response || null);
        });
      });
    } catch (e) {
      finish(null);
    }
  });
}

// 1 -> "1.0", 1.25 -> "1.25", 1.5 -> "1.5"
function formatSpeed(speed) {
  const rounded = Math.round(speed * 100) / 100;
  return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
}

async function refreshPageState() {
  const state = await sendToActiveTab({ action: 'getState' });
  if (!state) {
    updateVolumeUi(undefined, 'none');
    return;
  }

  pageHost = state.host || '';
  const speedInput = document.getElementById('directSetSpeed');
  if (speedInput && typeof state.speed === 'number') {
    speedInput.value = formatSpeed(state.speed);
  }
  updateVolumeUi(state.volumeBoost, state.volumeStatus);
}

async function applyCurrentSpeed() {
  const input = document.getElementById('directSetSpeed');
  const value = parseFloat(input.value);
  if (isNaN(value) || value <= 0) return;

  const res = await sendToActiveTab({ action: 'setSpeed', speed: value });
  // Показываем скорость, которая реально встала (страница могла её округлить или ограничить)
  if (res && typeof res.speed === 'number') {
    input.value = formatSpeed(res.speed);
  }
}

// boost — множитель (1.0-3.0) или undefined, если ползунок трогать не нужно
function updateVolumeUi(boost, status) {
  const slider = document.getElementById('volumeBoost');
  const valueEl = document.getElementById('volumeBoostValue');
  const hint = document.getElementById('volumeHint');
  if (!slider) return;

  if (typeof boost === 'number') {
    const percent = Math.round(boost * 100);
    slider.value = percent;
    if (valueEl) valueEl.textContent = `${percent}%`;
  }

  slider.disabled = status === 'none' || status === 'disabled';

  const messages = {
    none: 'Видео на этой странице не найдено. Если расширение только что обновили, перезагрузите вкладку.',
    disabled: 'Для этого сайта усиление отключено в чёрном списке.',
    unsupported: 'Сайт защищает это видео, поэтому звук усилить не получится.',
    pending: 'Кликните по странице, и усиление включится.',
    ok: pageHost ? `Значение запоминается для ${pageHost}` : 'Значение запоминается для этого сайта.'
  };
  if (hint) hint.textContent = messages[status] || messages.ok;
}

// ===== Шрифт расширения =====

function customFontFamilyName(id) {
  return 'OverclockFont_' + String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function loadCustomFontsMeta() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return [];
  const data = await chrome.storage.local.get({ customFontsMeta: [] });
  const list = Array.isArray(data.customFontsMeta) ? data.customFontsMeta : [];
  return list.filter(f => f && typeof f.id === 'string' && f.id && typeof f.name === 'string');
}

function populateFontSelect() {
  const select = document.getElementById('fontFamily');
  if (!select) return;

  const previous = select.value;
  select.innerHTML = '';

  const builtinGroup = document.createElement('optgroup');
  builtinGroup.label = 'Стандартные';
  BUILTIN_FONTS.forEach(font => {
    const option = document.createElement('option');
    option.value = font.id;
    option.textContent = font.label;
    builtinGroup.appendChild(option);
  });
  select.appendChild(builtinGroup);

  if (customFonts.length > 0) {
    const customGroup = document.createElement('optgroup');
    customGroup.label = 'Мои шрифты';
    customFonts.forEach(font => {
      const option = document.createElement('option');
      option.value = `custom:${font.id}`;
      option.textContent = font.name;
      customGroup.appendChild(option);
    });
    select.appendChild(customGroup);
  }

  if (Array.from(select.options).some(o => o.value === previous)) {
    select.value = previous;
  }
}

function updateDeleteFontBtn() {
  const select = document.getElementById('fontFamily');
  const btn = document.getElementById('deleteFontBtn');
  if (select && btn) btn.disabled = !select.value.startsWith('custom:');
}

function showFontHint(text, isError) {
  const hint = document.getElementById('fontHint');
  if (!hint) return;
  hint.textContent = text;
  hint.classList.toggle('error', !!isError);

  clearTimeout(fontHintTimer);
  fontHintTimer = setTimeout(() => {
    hint.textContent = FONT_HINT_DEFAULT;
    hint.classList.remove('error');
  }, 5000);
}

// Подключаем свой шрифт к окну через FontFace API. Возвращает имя семейства или null
async function ensureUiCustomFont(id) {
  const family = customFontFamilyName(id);
  if (uiFontFaces.has(id)) return family;

  try {
    const key = FONT_KEY_PREFIX + id;
    const data = await chrome.storage.local.get({ [key]: '' });
    if (!data[key]) return null;

    const face = new FontFace(family, base64ToArrayBuffer(data[key]), { weight: '100 900' });
    await face.load();
    document.fonts.add(face);
    uiFontFaces.set(id, face);
    return family;
  } catch (e) {
    return null;
  }
}

// Применяет шрифт к самому popup. Для "Стандартный" возвращает прежний вид
async function applyUiFont(fontId) {
  const token = ++uiFontToken;
  const root = document.documentElement;
  const id = fontId || 'default';

  let stack = '';
  if (id.startsWith('custom:')) {
    const family = await ensureUiCustomFont(id.slice(7));
    if (family) stack = `"${family}", system-ui, sans-serif`;
  } else {
    const builtin = BUILTIN_FONTS.find(f => f.id === id);
    if (builtin) stack = builtin.stack;
  }

  if (token !== uiFontToken) return; // за это время выбрали другой шрифт

  if (stack) {
    root.style.setProperty('--ui-font', stack);
    root.classList.add('has-ui-font');
  } else {
    root.style.removeProperty('--ui-font');
    root.classList.remove('has-ui-font');
  }
}

async function initFontControls() {
  customFonts = await loadCustomFontsMeta();

  // Сохранённый шрифт мог быть удалён: возвращаем стандартный
  const savedFont = currentSettings.fontFamily || 'default';
  const savedIsKnown = savedFont.startsWith('custom:')
    ? customFonts.some(f => `custom:${f.id}` === savedFont)
    : BUILTIN_FONTS.some(f => f.id === savedFont);
  if (!savedIsKnown) currentSettings.fontFamily = 'default';

  populateFontSelect();

  const select = document.getElementById('fontFamily');
  const uploadBtn = document.getElementById('uploadFontBtn');
  const deleteBtn = document.getElementById('deleteFontBtn');
  const fileInput = document.getElementById('fontFileInput');

  // Шрифт сразу виден в самом меню, ещё до нажатия "Сохранить"
  select?.addEventListener('change', () => {
    applyUiFont(select.value);
    updateDeleteFontBtn();
  });

  uploadBtn?.addEventListener('click', () => fileInput?.click());

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) await handleFontUpload(file);
  });

  deleteBtn?.addEventListener('click', deleteSelectedFont);
}

async function handleFontUpload(file) {
  if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) {
    showFontHint('Подходят только файлы TTF, OTF, WOFF и WOFF2.', true);
    return;
  }
  if (file.size > MAX_FONT_FILE_BYTES) {
    showFontHint('Файл больше 2 МБ. Возьмите шрифт полегче, например WOFF2.', true);
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);

    // Заодно проверяем, что браузер умеет читать этот файл
    const id = 'f' + Date.now().toString(36);
    const face = new FontFace(customFontFamilyName(id), buffer, { weight: '100 900' });
    await face.load();

    const name = file.name.replace(/\.[^.]+$/, '').trim().slice(0, 40) || 'Свой шрифт';
    const newList = [...customFonts, { id, name }];
    await chrome.storage.local.set({ [FONT_KEY_PREFIX + id]: base64, customFontsMeta: newList });

    document.fonts.add(face);
    uiFontFaces.set(id, face);
    customFonts = newList;

    populateFontSelect();
    const select = document.getElementById('fontFamily');
    select.value = `custom:${id}`;
    updateDeleteFontBtn();
    await applyUiFont(select.value);

    showFontHint(`Шрифт «${name}» добавлен. Нажмите «Сохранить», чтобы применить его на страницах.`, false);
    checkChangesOnInput();
  } catch (e) {
    const noSpace = e && /quota/i.test(String(e.message || e));
    showFontHint(
      noSpace
        ? 'В хранилище не хватает места. Удалите ненужные свои шрифты.'
        : 'Не удалось прочитать этот файл как шрифт.',
      true
    );
  }
}

function deleteSelectedFont() {
  const select = document.getElementById('fontFamily');
  const value = select ? select.value : '';
  if (!value.startsWith('custom:')) return;

  const id = value.slice('custom:'.length);
  const font = customFonts.find(f => f.id === id);

  showCustomConfirm(`Удалить шрифт «${font ? font.name : id}»?`, async () => {
    try {
      const newList = customFonts.filter(f => f.id !== id);
      const update = { customFontsMeta: newList };
      // Если этот шрифт был сохранён как рабочий, страницы должны вернуться к стандартному
      const wasSaved = currentSettings.fontFamily === value;
      if (wasSaved) update.fontFamily = 'default';

      await chrome.storage.local.set(update);
      await chrome.storage.local.remove(FONT_KEY_PREFIX + id);

      const face = uiFontFaces.get(id);
      if (face) {
        try { document.fonts.delete(face); } catch (e) { /* ignore */ }
        uiFontFaces.delete(id);
      }

      customFonts = newList;
      if (wasSaved) currentSettings.fontFamily = 'default';

      populateFontSelect();
      const fallback = currentSettings.fontFamily || 'default';
      select.value = Array.from(select.options).some(o => o.value === fallback) ? fallback : 'default';
      updateDeleteFontBtn();
      await applyUiFont(select.value);

      showFontHint('Шрифт удалён.', false);
      checkChangesOnInput();
    } catch (e) {
      showFontHint('Не удалось удалить шрифт.', true);
    }
  });
}
