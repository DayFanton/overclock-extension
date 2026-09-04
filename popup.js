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
  blacklist: []
};

let currentSettings = { ...defaultSettings };
let tempCustomBinds = [];
let tempCustomRewindBinds = [];
let tempBlacklist = [];
let activeSection = 'general';

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
  }

  loadSettingsToUI(currentSettings);

  document.getElementById('infoBtn')?.addEventListener('click', () => {
    document.getElementById('infoModal').style.display = 'flex';
  });

  document.getElementById('closeInfoBtn')?.addEventListener('click', () => {
    document.getElementById('infoModal').style.display = 'none';
  });

  document.getElementById('applyCurrentSpeedBtn')?.addEventListener('click', () => {
    const val = parseFloat(document.getElementById('directSetSpeed').value);
    if (!isNaN(val) && val > 0) {
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'setSpeed', speed: val });
          }
        });
      }
    }
  });

  setupKeyInput('directInputCombo', true);
  setupKeyInput('timecodeModifier', true);
  setupKeyInput('codeRewindBack', false);
  setupKeyInput('codeRewindForward', false);
  setupKeyInput('codeFrameBack', false);
  setupKeyInput('codeFrameForward', false);

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
          enabledFeatures: { speed: true, rewind: true, digits: true, timecode: true }
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

function normalizeBlacklist(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList.map(item => {
    if (typeof item === 'string') {
      return {
        domain: item,
        enabledFeatures: { speed: false, rewind: false, digits: false, timecode: false }
      };
    }
    let enabled = {};
    if (item.enabledFeatures) {
      enabled = {
        speed: item.enabledFeatures.speed !== false,
        rewind: item.enabledFeatures.rewind !== false,
        digits: item.enabledFeatures.digits !== false,
        timecode: item.enabledFeatures.timecode !== false
      };
    } else {
      enabled = { speed: true, rewind: true, digits: true, timecode: true };
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
      parseFloat(document.getElementById('minSpeed')?.value) !== currentSettings.minSpeed ||
      parseFloat(document.getElementById('maxSpeed')?.value) !== currentSettings.maxSpeed ||
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

    return (
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

function setupKeyInput(elementId, isComboObject) {
  const input = document.getElementById(elementId);
  if (!input) return;

  input.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

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
        input.dataset.combo = JSON.stringify(capturedCombo);
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
      if (isComboObject && (capturedCombo.ctrl || capturedCombo.shift || capturedCombo.alt)) {
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
      { key: 'timecode', label: 'Ввод таймкода' }
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
  if (document.getElementById('minSpeed')) document.getElementById('minSpeed').value = s.minSpeed;
  if (document.getElementById('maxSpeed')) document.getElementById('maxSpeed').value = s.maxSpeed;

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
    currentSettings.minSpeed = parseFloat(document.getElementById('minSpeed')?.value) || 0.1;
    currentSettings.maxSpeed = parseFloat(document.getElementById('maxSpeed')?.value) || 16.0;
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
        currentSettings.minSpeed = defaultSettings.minSpeed;
        currentSettings.maxSpeed = defaultSettings.maxSpeed;
        currentSettings.rewindBackSec = defaultSettings.rewindBackSec;
        currentSettings.rewindForwardSec = defaultSettings.rewindForwardSec;
      } else if (section === 'hotkeys') {
        currentSettings.directInputCombo = defaultSettings.directInputCombo;
        currentSettings.timecodeModifier = defaultSettings.timecodeModifier;
        currentSettings.codeRewindBack = defaultSettings.codeRewindBack;
        currentSettings.codeRewindForward = defaultSettings.codeRewindForward;
        currentSettings.codeFrameBack = defaultSettings.codeFrameBack;
        currentSettings.codeFrameForward = defaultSettings.codeFrameForward;
        currentSettings.customSpeedBinds = [];
        currentSettings.customRewindBinds = [];
      } else if (section === 'design') {
        currentSettings.textColor = defaultSettings.textColor;
        currentSettings.bgColorRgba = defaultSettings.bgColorRgba;
        currentSettings.fontSize = defaultSettings.fontSize;
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