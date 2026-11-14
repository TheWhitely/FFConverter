(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const canvas = $('#timeline-canvas');
  const duration = 48;
  const state = { start: 8.4, end: 32.8, position: 8.4, playing: false, speed: 2, previewSpeed: 1, snapping: true, frame: null, lastTick: 0, effects: {} };
  let drag = null;
  let effectDrag = null;

  const definitions = {
    blur: { name: 'Размытие', icon: 'effects', value: () => `${$('#blur-range').value} px` },
    speed: { name: 'Скорость', icon: 'forward', value: () => `${state.speed}×` },
    brightness: { name: 'Яркость', icon: 'film', value: () => 'Цвет' },
    fade: { name: 'Fade', icon: 'film', value: () => 'In / out' },
    saturation: { name: 'Насыщенность', icon: 'film', value: () => 'Цвет' }
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const percent = (value) => `${(value / duration) * 100}%`;
  function formatTime(value, milliseconds = true) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return milliseconds ? `${base}.${String(Math.floor((value % 1) * 1000)).padStart(3, '0')}` : base;
  }

  function updateEffectClips() {
    $$('.effect-clip[data-effect-id]').forEach((clip) => {
      const effect = state.effects[clip.dataset.effectId];
      if (!effect) return;
      clip.style.left = percent(effect.start);
      clip.style.width = percent(effect.end - effect.start);
      $('b', clip).textContent = definitions[effect.id].value();
    });
  }

  function renderEffects() {
    const labels = $('#vfx-labels');
    const rows = $('#vfx-rows');
    labels.textContent = '';
    rows.textContent = '';
    const ids = Object.keys(state.effects);
    ids.forEach((id, index) => {
      const definition = definitions[id];
      const label = document.createElement('div');
      label.className = 'track-label';
      label.textContent = `VFX ${index + 1}`;
      labels.append(label);
      const row = document.createElement('div');
      row.className = 'timeline-row effect-row';
      const clip = document.createElement('div');
      clip.className = 'effect-clip';
      clip.dataset.effectId = id;
      clip.setAttribute('role', 'group');
      clip.setAttribute('aria-label', `${definition.name}: перетащить или изменить диапазон`);
      clip.innerHTML = `<svg class="m-icon"><use href="#i-${definition.icon}"/></svg><span>${definition.name}</span><b></b><button class="effect-resize start" data-effect-handle="start" type="button" aria-label="Начало эффекта"></button><button class="effect-resize end" data-effect-handle="end" type="button" aria-label="Конец эффекта"></button>`;
      row.append(clip);
      rows.append(row);
    });
    canvas.style.height = `${188 + ids.length * 32}px`;
    $('.timeline-tracks').style.height = `${160 + ids.length * 32}px`;
    document.documentElement.style.setProperty('--timeline-height', `${258 + ids.length * 32}px`);
    $('#effect-count').textContent = `${ids.length} эффекта · 3 аудиодорожки`;
    updateEffectClips();
  }

  function setEffect(id, enabled) {
    const exists = Boolean(state.effects[id]);
    if (enabled === exists) return;
    if (enabled) state.effects[id] = { id, start: state.start, end: state.end };
    else delete state.effects[id];
    renderEffects();
  }

  function render() {
    canvas.style.setProperty('--start', percent(state.start));
    canvas.style.setProperty('--end', percent(state.end));
    canvas.style.setProperty('--position', percent(state.position));
    const selected = state.end - state.start;
    $('#selection-status').textContent = `Фрагмент ${selected.toFixed(1).replace('.', ',')} с`;
    $('#speed-before').textContent = `${selected.toFixed(1).replace('.', ',')} с`;
    $('#speed-after').textContent = `${(selected / state.speed).toFixed(1).replace('.', ',')} с`;
    $('#current-time').textContent = formatTime(state.position);
  }

  function setPlaying(playing) {
    state.playing = playing;
    $('#stage-play').classList.toggle('is-playing', playing);
    $('#play-button').classList.toggle('is-playing', playing);
    const name = playing ? 'pause' : 'play';
    $('#stage-play use').setAttribute('href', `#i-${name}`);
    $('#play-button use').setAttribute('href', `#i-${name}`);
    $('#stage-play').setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
    $('#play-button').setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
  }

  function tick(timestamp) {
    if (!state.playing) return;
    if (!state.lastTick) state.lastTick = timestamp;
    state.position += ((timestamp - state.lastTick) / 1000) * state.previewSpeed;
    state.lastTick = timestamp;
    if (state.position >= state.end) {
      state.position = state.start;
      setPlaying(false);
    } else {
      state.frame = requestAnimationFrame(tick);
    }
    render();
  }

  function togglePlayback() {
    if (state.playing) {
      cancelAnimationFrame(state.frame);
      state.lastTick = 0;
      setPlaying(false);
      return;
    }
    if (state.position >= state.end || state.position < state.start) state.position = state.start;
    setPlaying(true);
    state.frame = requestAnimationFrame(tick);
  }

  $('#stage-play').addEventListener('click', togglePlayback);
  $('#play-button').addEventListener('click', togglePlayback);

  function showSnap(value, label) {
    $('#snap-line').style.left = percent(value);
    $('#snap-label').textContent = label;
    $('#snap-line').hidden = false;
  }

  function moveEffect(event) {
    if (!effectDrag) return;
    const rect = canvas.getBoundingClientRect();
    const pixelsPerSecond = rect.width / duration;
    const effect = state.effects[effectDrag.id];
    if (!effect) return;
    const candidates = [{ value: state.start, label: 'Начало' }, { value: state.end, label: 'Конец' }, { value: state.position, label: 'Playhead' }];
    $('#snap-line').hidden = true;
    if (effectDrag.mode === 'move') {
      const delta = (event.clientX - effectDrag.x) / pixelsPerSecond;
      const length = effectDrag.end - effectDrag.start;
      let start = clamp(effectDrag.start + delta, 0, duration - length);
      let end = start + length;
      if (state.snapping) {
        for (const candidate of candidates) {
          if (Math.abs(start - candidate.value) * pixelsPerSecond <= 12) {
            start = candidate.value; end = start + length; showSnap(start, candidate.label); break;
          }
          if (Math.abs(end - candidate.value) * pixelsPerSecond <= 12) {
            end = candidate.value; start = end - length; showSnap(end, candidate.label); break;
          }
        }
      }
      effect.start = clamp(start, 0, duration - length);
      effect.end = effect.start + length;
    } else {
      let value = clamp((event.clientX - rect.left) / pixelsPerSecond, 0, duration);
      if (state.snapping) {
        for (const candidate of candidates) {
          if (Math.abs(value - candidate.value) * pixelsPerSecond <= 12) {
            value = candidate.value; showSnap(value, candidate.label); break;
          }
        }
      }
      if (effectDrag.mode === 'start') effect.start = clamp(Math.min(value, effect.end - .5), 0, duration);
      if (effectDrag.mode === 'end') effect.end = clamp(Math.max(value, effect.start + .5), 0, duration);
    }
    updateEffectClips();
  }

  function move(event) {
    if (effectDrag) { moveEffect(event); return; }
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const pixelsPerSecond = rect.width / duration;
    let value = clamp((event.clientX - rect.left) / pixelsPerSecond, 0, duration);
    $('#snap-line').hidden = true;
    if (state.snapping) {
      const candidates = drag === 'playhead'
        ? [{ value: state.start, label: 'Начало' }, { value: state.end, label: 'Конец' }]
        : [{ value: state.position, label: 'Playhead' }];
      for (const candidate of candidates) {
        if (Math.abs(value - candidate.value) * pixelsPerSecond <= 12) {
          value = candidate.value;
          showSnap(candidate.value, candidate.label);
          break;
        }
      }
    }
    if (drag === 'start') state.start = clamp(Math.min(value, state.end - .5), 0, duration);
    if (drag === 'end') state.end = clamp(Math.max(value, state.start + .5), 0, duration);
    if (drag === 'playhead') state.position = value;
    render();
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const clip = event.target.closest('.effect-clip[data-effect-id]');
    if (clip) {
      effectDrag = {
        id: clip.dataset.effectId,
        mode: event.target.closest('[data-effect-handle]')?.dataset.effectHandle || 'move',
        x: event.clientX,
        start: state.effects[clip.dataset.effectId].start,
        end: state.effects[clip.dataset.effectId].end
      };
    } else {
      drag = event.target.closest('[data-drag]')?.dataset.drag || 'playhead';
    }
    canvas.setPointerCapture(event.pointerId);
    move(event);
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', move);
  const stop = (event) => {
    drag = null;
    effectDrag = null;
    $('#snap-line').hidden = true;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  $('.playhead').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : .1;
    state.position = event.key === 'Home' ? state.start : event.key === 'End' ? state.end : clamp(state.position + (event.key === 'ArrowLeft' ? -step : step), 0, duration);
    render();
  });

  $('#snap-toggle').addEventListener('click', () => {
    state.snapping = !state.snapping;
    $('#snap-toggle').classList.toggle('is-active', state.snapping);
    $('#snap-caption').textContent = state.snapping ? 'Притяжение включено' : 'Притяжение выключено';
  });
  $('#timeline-zoom').addEventListener('input', (event) => {
    canvas.style.setProperty('--zoom', Number(event.target.value) / 100);
  });
  $('#blur-range').addEventListener('input', () => {
    $('#blur-value').textContent = `${$('#blur-range').value} px`;
    updateEffectClips();
  });
  $$('.speed-control button').forEach((button) => button.addEventListener('click', () => {
    state.speed = Number(button.textContent.replace(',', '.').replace('×', ''));
    $('#speed-badge').textContent = button.textContent;
    updateEffectClips();
    render();
  }));

  $$('details[data-effect]').forEach((details) => {
    details.addEventListener('toggle', () => setEffect(details.dataset.effect, details.open));
    $('summary', details).addEventListener('click', () => setEffect(details.dataset.effect, !details.open));
  });
  $$('.correction-list [data-effect]').forEach((button) => {
    button.addEventListener('click', () => setEffect(button.dataset.effect, true));
  });
  $$('.effect-area button').forEach((button) => button.addEventListener('click', () => {
    const area = button.textContent.includes('Выбрать');
    $('#blur-area-button').hidden = !area;
    $('#blur-region').hidden = !area;
  }));
  $('#blur-area-button').addEventListener('click', () => {
    $('#blur-region').hidden = !$('#blur-region').hidden;
  });

  function replaceNativeSelects() {
    $$('select.m-select').forEach((select) => {
      const label = select.getAttribute('aria-label') || select.closest('.m-field')?.querySelector('.m-label')?.textContent || 'Выбор';
      const combo = document.createElement('div');
      combo.className = 'm-combobox';
      combo.dataset.combobox = '';
      combo.innerHTML = `<button class="m-combobox-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="${label}"><span class="m-combobox-value"></span><svg class="m-icon"><use href="#i-chevron"/></svg></button><div class="m-combobox-list" role="listbox" aria-label="${label}"></div>`;
      const value = $('.m-combobox-value', combo);
      const list = $('[role="listbox"]', combo);
      Array.from(select.options).forEach((option) => {
        const item = document.createElement('button');
        item.className = 'm-combobox-option';
        item.type = 'button';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.selected));
        item.innerHTML = `${option.textContent}<svg class="m-icon m-combobox-selected-icon"><use href="#i-check"/></svg>`;
        list.append(item);
      });
      value.textContent = (select.selectedOptions[0] || select.options[0]).textContent;
      if (select.classList.contains('playback-speed')) {
        combo.addEventListener('mono:change', (event) => {
          state.previewSpeed = Number(String(event.detail.value).replace(',', '.').replace('×', ''));
        });
      }
      select.replaceWith(combo);
    });
  }

  function placeCombobox(combo) {
    const rect = combo.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    combo.classList.toggle('is-upward', below < 190 && rect.top > below);
    const section = combo.closest('.effect-section');
    if (section) section.style.overflow = 'visible';
  }

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('.m-combobox-trigger');
    if (trigger) placeCombobox(trigger.closest('.m-combobox'));
    $$('.effect-section').forEach((section) => {
      if (!section.querySelector('.m-combobox.is-open')) section.style.removeProperty('overflow');
    });
  });
  document.addEventListener('contextmenu', (event) => event.preventDefault());

  function createCustomScrollbar(element, className) {
    const wrapper = document.createElement('div');
    wrapper.className = `custom-scroll-wrap ${className}`;
    element.parentElement.insertBefore(wrapper, element);
    wrapper.append(element);
    element.dataset.customScroll = 'true';
    const rail = document.createElement('div');
    rail.className = 'custom-scroll-rail';
    const thumb = document.createElement('button');
    thumb.className = 'custom-scroll-thumb';
    thumb.type = 'button';
    thumb.setAttribute('aria-label', 'Прокрутка');
    rail.append(thumb);
    wrapper.append(rail);
    const update = () => {
      const available = element.clientHeight;
      rail.hidden = element.scrollHeight <= available + 1;
      if (rail.hidden) return;
      const thumbHeight = Math.max(24, available * available / element.scrollHeight);
      const top = (element.scrollTop / (element.scrollHeight - available)) * (available - thumbHeight);
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${top}px)`;
    };
    element.addEventListener('scroll', update);
    new ResizeObserver(update).observe(wrapper);
    thumb.addEventListener('pointerdown', (event) => {
      const startY = event.clientY;
      const startScroll = element.scrollTop;
      thumb.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        const ratio = (element.scrollHeight - element.clientHeight) / Math.max(1, element.clientHeight - thumb.offsetHeight);
        element.scrollTop = startScroll + (moveEvent.clientY - startY) * ratio;
      };
      const stop = () => {
        thumb.removeEventListener('pointermove', move);
        thumb.removeEventListener('pointerup', stop);
        thumb.removeEventListener('pointercancel', stop);
      };
      thumb.addEventListener('pointermove', move);
      thumb.addEventListener('pointerup', stop);
      thumb.addEventListener('pointercancel', stop);
      event.preventDefault();
    });
    update();
  }

  const audioLabels = $('#audio-labels');
  const audioRows = $('#audio-rows');
  audioLabels.addEventListener('scroll', () => { audioRows.scrollTop = audioLabels.scrollTop; });
  audioRows.addEventListener('scroll', () => { audioLabels.scrollTop = audioRows.scrollTop; });

  for (let index = 0; index < 12; index++) $('#clip-thumbnails').append(document.createElement('span'));
  [0, 12, 24, 36, 48].forEach((value) => {
    const label = document.createElement('span');
    label.textContent = formatTime(value, false);
    $('#timeline-ruler').append(label);
  });
  replaceNativeSelects();
  Mono.init();
  $$('.inspector-tabs .m-tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.inspector-tabs .m-tab').forEach((item) => {
      const active = item === tab;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });
    $$('.inspector-panel').forEach((panel) => { panel.hidden = panel.id !== tab.getAttribute('aria-controls'); });
  }));
  $$('details[data-effect][open]').forEach((details) => setEffect(details.dataset.effect, true));
  renderEffects();
  $('#blur-value').textContent = `${$('#blur-range').value} px`;
  render();
  createCustomScrollbar($('.inspector-scroll'), 'inspector-wrap');
  createCustomScrollbar(audioRows, 'audio-wrap');
})();
