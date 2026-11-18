(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const icon = (name) => `<svg class="m-icon"><use href="#i-${name}"></use></svg>`;
  const desktop = Boolean(window.__TAURI__?.core);
  const api = desktop ? window.__TAURI__ : null;
  const invoke = (command, args = {}) => api.core.invoke(command, args);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const elements = {
    welcome: $('#welcome-screen'), workspace: $('#workspace'), fileInput: $('#file-input'), dropZone: $('#drop-zone'),
    video: $('#video-preview'), poster: $('#demo-poster'), timeline: $('#timeline-track'), centerPlay: $('#center-play'),
    playButton: $('#play-button'), quality: $('#quality-range'), codec: $('#codec-select'), encoder: $('#encoder-select'),
    container: $('#container-select'), cropOverlay: $('#crop-overlay'), exportModal: $('#export-modal'),
    helpModal: $('#help-modal'), updateModal: $('#update-modal')
  };
  const state = {
    duration: 41, position: 0, start: 0, end: 41, isDemo: true, playing: false, demoFrame: null, lastDemoTick: 0,
    cropRatio: 'free', crop: null, cropVisible: false, objectUrl: null, media: null, originalWidth: 1920, originalHeight: 1080,
    audio: [], audioPlayers: [], audioContext: null, masterMuted: false, exportKind: 'video', activeJob: null, exportOutput: '', restoreExportModal: false,
    loadToken: 0, settings: {}, settingsReady: false, encoderSupport: null, saveTimer: null, update: null, updateBusy: false,
    updatePromptShown: false, scrubbing: false, resumeAfterScrub: false, previewSpeed: 1, snapping: true,
    effects: [], deletedEffects: [], vfxTracks: 2, selectedEffect: null, nextEffectId: 1, blurEffectId: null,
    blurRegion: { x: .32, y: .24, width: .36, height: .46 }, blurVisible: false, blurAnimation: null, blurVideoFrame: null,
    colorHsv: { h: 340, s: .65, v: .98 }
  };
  const effectDefinitions = {
    blur: { name: 'Размытие', icon: 'effects' },
    speed: { name: 'Скорость', icon: 'forward' },
    color: { name: 'Цвет', icon: 'film' }
  };
  const presets = {
    quality: { codec: 'AV1', encoder: 'NVIDIA NVENC', quality: 21, label: 'Качество' },
    balance: { codec: 'HEVC', encoder: 'NVIDIA NVENC', quality: 21, label: 'Баланс' }
  };
  const videoFilters = [{ name: 'Видео', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'ts', 'm2ts'] }];
  const toast = (message, type = 'info', options = {}) => window.Mono?.toast(message, { ...options, type });

  function formatTime(seconds, milliseconds = false) {
    const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const wholeSeconds = Math.floor(safe % 60);
    const base = hours > 0 ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}`;
    return milliseconds ? `${base}.${String(Math.floor((safe % 1) * 1000)).padStart(3, '0')}` : base;
  }
  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Локальный файл';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(unit >= 2 && value < 100 ? 1 : 0).replace('.', ',')} ${units[unit]}`;
  }
  function setRangeFill(input) {
    if (!input) return;
    const min = Number(input.min) || 0, max = Number(input.max) || 100;
    const value = `${((Number(input.value) - min) / (max - min)) * 100}%`;
    input.style.setProperty('--m-range-value', value);
    input.style.setProperty('--val', value);
  }
  function applyAccent(value) {
    const color = /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : '#fa5782';
    const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
    const mix = (target, amount) => rgb.map((channel, index) => Math.round(channel + (target[index] - channel) * amount));
    const hex = (channels) => `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
    const root = document.documentElement.style;
    const brightness = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
    const contrast = brightness > 160 ? '#0e0e0e' : '#ffffff';
    root.setProperty('--accent', color); root.setProperty('--m-accent', color);
    root.setProperty('--m-accent-contrast', contrast); root.setProperty('--accent-contrast', contrast);
    root.setProperty('--accent-rgb', rgb.join(',')); root.setProperty('--accent-2', hex(mix([255, 255, 255], .22)));
    root.setProperty('--accent-deep', hex(mix([0, 0, 0], .18))); root.setProperty('--accent-soft', `rgba(${rgb.join(',')},.12)`);
    root.setProperty('--m-accent-soft', `color-mix(in srgb, ${color} 8%, var(--m-surface))`);
    root.setProperty('--accent-glow', `rgba(${rgb.join(',')},.35)`);
    $('#accent-color').value = color; $('#accent-value').textContent = color.toUpperCase();
    $('#accent-swatch').style.background = color; $('#color-hex').value = color.toUpperCase();
    const [r, g, b] = rgb.map((channel) => channel / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let hue = 0;
    if (delta) {
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
    }
    state.colorHsv = { h: (hue + 360) % 360, s: max ? delta / max : 0, v: max };
    $('#color-hue').value = Math.round(state.colorHsv.h); setRangeFill($('#color-hue'));
    if (!$('#color-picker').hidden) drawColorField();
  }
  const baseFileName = (name) => name.replace(/\.[^.]+$/, '');
  const sectionOpen = (id) => Boolean($(`#${id}-section`)?.open);
  function originalExtension() { return state.media?.name?.match(/\.([^.]+)$/)?.[1].toLowerCase() || 'mp4'; }
  function automaticCodec(extension) {
    if (extension === 'webm') return 'AV1';
    const source = state.media?.codec?.toLowerCase();
    return source === 'h264' ? 'H.264' : ['hevc', 'h265'].includes(source) ? 'HEVC' : source === 'av1' ? 'AV1' : 'H.264';
  }
  function canCopyVideo(extension) {
    if (extension === originalExtension()) return true;
    const source = state.media?.codec?.toLowerCase();
    if (['mkv', 'avi', 'ts', 'm2ts'].includes(extension)) return true;
    if (['mp4', 'mov', 'm4v'].includes(extension)) return ['h264', 'hevc', 'h265', 'av1', 'mpeg4'].includes(source);
    return extension === 'webm' && ['vp8', 'vp9', 'av1'].includes(source);
  }
  function activeEffects() { return Object.values(state.effects); }
  function videoOptions() {
    const conversion = sectionOpen('conversion'), compression = sectionOpen('compression'), resolution = sectionOpen('resolution');
    const crop = sectionOpen('crop') ? state.crop : null;
    const extension = conversion && elements.container.value !== 'original' ? elements.container.value.toLowerCase() : originalExtension();
    const even = (value) => Math.max(16, Math.round(value / 2) * 2);
    const width = resolution ? even(Number($('#width-input').value) || state.originalWidth) : crop ? even(crop.width * state.originalWidth) : state.originalWidth;
    const height = resolution ? even(Number($('#height-input').value) || state.originalHeight) : crop ? even(crop.height * state.originalHeight) : state.originalHeight;
    const transformed = Boolean(crop) || width !== state.originalWidth || height !== state.originalHeight;
    const effects = state.exportKind === 'video' ? activeEffects() : [];
    const fast = $('#trim-mode button.active').dataset.mode === 'fast' && !effects.length;
    const codec = compression ? elements.codec.value : automaticCodec(extension), encoder = compression ? elements.encoder.value : 'CPU';
    const copyVideo = state.exportKind === 'video' && !transformed && !effects.length && canCopyVideo(extension) && (fast || !compression);
    return {
      conversion, compression, resolution, crop, extension, width, height, transformed, fast, codec, encoder, copyVideo, effects,
      quality: compression ? Number(elements.quality.value) : 23,
      audioCodec: state.exportKind === 'audio' ? $('#audio-codec').value : extension === 'webm' ? 'opus' : $('.audio-output').open ? $('#audio-codec').value : 'original',
      keepMetadata: conversion ? $('#keep-metadata').checked : true, keepSubtitles: conversion ? $('#keep-subtitles').checked : true
    };
  }
  function ensurePreciseForTransforms() {
    const options = videoOptions();
    if ((!options.transformed && !options.effects.length) || !$('#trim-mode button.active')) return;
    $$('#trim-mode button').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === 'precise');
      button.classList.toggle('is-active', button.dataset.mode === 'precise');
    });
  }
  const selectedAudioTracks = () => state.audio.filter((track) => track.enabled);
  const audioExtension = () => ({ aac: 'm4a', mp3: 'mp3', flac: 'flac', wav: 'wav', opus: 'ogg' })[$('#audio-codec').value] || 'mp3';
  const currentExtension = () => state.exportKind === 'video' ? videoOptions().extension : state.exportKind === 'audio' ? audioExtension() : state.exportKind;
  function outputName() {
    const name = state.media?.name || 'Showreel_2026.mp4', extension = currentExtension();
    if (state.exportKind === 'video') return `${baseFileName(name)}_${videoOptions().copyVideo ? 'cut' : 'converted'}.${extension}`;
    if (state.exportKind === 'gif') return `${baseFileName(name)}.gif`;
    if (state.exportKind === 'audio') return `${baseFileName(name)}_audio.${extension}`;
    return `${baseFileName(name)}_${String(Math.round(state.position * 1000)).padStart(7, '0')}.${extension}`;
  }
  function updateOutputName() {
    const options = videoOptions(), extension = currentExtension();
    $('#container-select option[value="original"]').textContent = `Оригинал (${originalExtension().toUpperCase()})`;
    const sequence = ['png', 'jpg'].includes(state.exportKind) && !$('#single-frame').checked;
    $('#output-file-name').textContent = sequence ? `frame_00001.${extension} …` : outputName();
    $('#output-format').textContent = extension.toUpperCase();
    const resolution = `${options.width} × ${options.height}`;
    const videoLabel = options.copyVideo ? 'Без перекодирования' : options.compression ? options.codec : `Авто · ${options.codec}`;
    $('#export-summary').textContent = state.exportKind === 'video' ? `${extension.toUpperCase()} · ${videoLabel} · ${resolution}` : state.exportKind === 'audio' ? `${extension.toUpperCase()} · ${selectedAudioTracks().length} дор. · ${formatTime(state.start)} — ${formatTime(state.end)}` : `${state.exportKind.toUpperCase()} · ${resolution}${state.exportKind === 'gif' ? ` · ${$('#fps-range').value} FPS` : ''}`;
    const activePreset = $('#preset-grid button.is-active')?.dataset.preset;
    $('#compression-summary').textContent = !options.compression ? 'Не применяется' : options.copyVideo ? 'Без перекодирования' : `${presets[activePreset]?.label || 'Пользовательский'} · ${elements.codec.value}`;
    $('#conversion-section summary small').textContent = options.conversion && elements.container.value !== 'original' ? `${extension.toUpperCase()} · контейнер` : `Оригинал · ${originalExtension().toUpperCase()}`;
    const activeResolution = $('#resolution-presets button.active')?.textContent || 'Пользовательское';
    $('#resolution-summary').textContent = options.resolution ? `${activeResolution} · ${options.width} × ${options.height}` : 'Не применяется';
    $('#crop-summary').textContent = !sectionOpen('crop') ? 'Не применяется' : state.crop ? `${Math.round(state.crop.width * state.originalWidth) & ~1} × ${Math.round(state.crop.height * state.originalHeight) & ~1} · ${state.cropRatio}` : 'Весь кадр';
    $('#export-button > span').textContent = state.activeJob ? 'Экспорт…' : state.exportKind === 'video' ? 'Экспортировать' : state.exportKind === 'audio' ? 'Извлечь аудио' : `Сохранить ${extension.toUpperCase()}`;
    if (state.position >= 0) $('#frame-time-label').textContent = `Позиция ${formatTime(state.position, true)}`;
    $('#export-button').disabled = Boolean(state.activeJob);
  }

  function effectValue(effect) {
    if (effect.kind === 'blur') return `${effect.intensity} px`;
    if (effect.kind === 'speed') return `${effect.rate}×`;
    return 'Коррекция';
  }
  function selectedEffect(kind = null) {
    const effect = state.effects.find((item) => item.id === state.selectedEffect);
    return effect && (!kind || effect.kind === kind) ? effect : null;
  }
  function effectAtPosition(kind) {
    return state.effects.find((effect) => effect.kind === kind && state.position >= effect.start && state.position < effect.end) || null;
  }
  function updateTimelineLayout() {
    const vfxHeight = state.vfxTracks * 32, audioHeight = 0;
    const tracksHeight = vfxHeight + 64 + audioHeight;
    elements.timeline.style.height = `${tracksHeight + 28}px`;
    $('.timeline-tracks').style.height = `${tracksHeight}px`;
    document.documentElement.style.setProperty('--timeline-height', `${tracksHeight + 98}px`);
    ['#audio-labels', '#audio-rows', '.custom-scroll-wrap.audio-wrap'].forEach((selector) => { const element = $(selector); if (element) { element.style.height = `${audioHeight}px`; element.style.flexBasis = `${audioHeight}px`; } });
    $('#add-vfx-track').disabled = false;
    $('#add-vfx-track').textContent = state.vfxTracks < 3 ? '+ VFX' : '− VFX';
    $('#add-vfx-track').setAttribute('aria-label', state.vfxTracks < 3 ? 'Добавить третью VFX-дорожку' : 'Удалить третью VFX-дорожку');
  }
  function renderEffects() {
    const labels = $('#vfx-labels'), rows = $('#vfx-rows');
    labels.textContent = ''; rows.textContent = '';
    for (let track = 0; track < state.vfxTracks; track++) {
      const label = document.createElement('div'); label.className = 'track-label'; label.textContent = `VFX ${track + 1}`; labels.append(label);
      const row = document.createElement('div'); row.className = 'timeline-row effect-row'; row.dataset.vfxTrack = track;
      state.effects.filter((effect) => effect.track === track).forEach((effect) => {
        const definition = effectDefinitions[effect.kind], clip = document.createElement('div');
        clip.className = 'effect-clip'; clip.dataset.effectId = effect.id; clip.tabIndex = 0;
        clip.setAttribute('role', 'group'); clip.setAttribute('aria-label', `${definition.name}: перетащить, растянуть или перенести на другую дорожку`);
        clip.innerHTML = `${icon(definition.icon)}<span>${definition.name}</span><b>${effectValue(effect)}</b><button class="effect-resize start" data-effect-handle="start" type="button" aria-label="Начало эффекта"></button><button class="effect-resize end" data-effect-handle="end" type="button" aria-label="Конец эффекта"></button>`;
        row.append(clip);
      });
      rows.append(row);
    }
    Object.keys(effectDefinitions).forEach((kind) => { $(`[data-effect-count="${kind}"]`).textContent = `${state.effects.filter((effect) => effect.kind === kind).length} клипов`; });
    $('#effect-count').textContent = `${state.effects.length} эффектов · ${state.audio.length} аудиодорожек`;
    updateTimelineLayout(); updateEffectClips();
  }
  function updateEffectClips() {
    $$('.effect-clip[data-effect-id]').forEach((clip) => {
      const effect = state.effects.find((item) => item.id === clip.dataset.effectId); if (!effect) return;
      clip.style.left = `${effect.start / state.duration * 100}%`;
      clip.style.width = `${(effect.end - effect.start) / state.duration * 100}%`;
      clip.classList.toggle('is-selected', effect.id === state.selectedEffect);
      $('b', clip).textContent = effectValue(effect);
    });
    const speed = selectedEffect('speed'), length = speed ? speed.end - speed.start : 0;
    $('#speed-before').textContent = `${length.toFixed(1).replace('.', ',')} с`;
    $('#speed-after').textContent = `${speed ? (length / speed.rate).toFixed(1).replace('.', ',') : '0'} с`;
    updateEffectPreview();
  }
  function hasOverlap(kind, track, start, end, ignoreId = null) {
    return state.effects.some((effect) => effect.id !== ignoreId && start < effect.end - .0001 && end > effect.start + .0001 && (effect.kind === 'speed' && kind === 'speed' || effect.track === track));
  }
  function effectPlacement(kind, length) {
    for (let track = 0; track < state.vfxTracks; track++) {
      const start = clamp(state.position, 0, state.duration - length);
      if (!hasOverlap(kind, track, start, start + length)) return { track, start, end: start + length };
    }
    for (let offset = .1; offset <= state.duration; offset += .1) {
      for (const direction of [1, -1]) {
        const start = state.position + offset * direction;
        if (start < 0 || start + length > state.duration) continue;
        for (let track = 0; track < state.vfxTracks; track++) {
          if (!hasOverlap(kind, track, start, start + length)) return { track, start, end: start + length };
        }
      }
    }
    return null;
  }
  function addEffect(kind) {
    const length = Math.min(3, Math.max(.2, state.duration)), placement = effectPlacement(kind, length);
    if (!placement) { toast('Нет свободного места. Передвиньте клипы или добавьте VFX-дорожку.', 'warning'); return; }
    const effect = {
      id: `effect-${state.nextEffectId++}`, kind, ...placement, enabled: true,
      intensity: Number($('#blur-range').value), rate: Number($('#speed-control .is-active').dataset.speed),
      brightness: Number($('#brightness-range').value) / 100, contrast: Number($('#contrast-range').value) / 100,
      saturation: Number($('#saturation-range').value) / 100,
      area: $('#blur-area-mode .is-active').dataset.area === 'region' ? { ...state.blurRegion } : null
    };
    state.effects.push(effect); state.selectedEffect = effect.id;
    ensurePreciseForTransforms(); renderEffects(); selectEffect(effect.id, false); updateOutputName();
  }
  function selectEffect(id, openPanel = true) {
    const effect = state.effects.find((item) => item.id === id); if (!effect) return;
    state.selectedEffect = id;
    if (openPanel) { $('#effects-tab').click(); $(`details[data-effect="${effect.kind}"]`).open = true; }
    if (effect.kind === 'blur') {
      state.blurEffectId = effect.id;
      if (state.position < effect.start || state.position >= effect.end) seek(effect.start);
      elements.video.pause(); stopDemoPlayback(); setPlaying(false);
      $('#blur-range').value = effect.intensity; state.blurRegion = effect.area ? { ...effect.area } : { x: .32, y: .24, width: .36, height: .46 };
      state.blurVisible = Boolean(effect.area);
      $$('#blur-area-mode button').forEach((button) => { button.classList.toggle('is-active', button.dataset.area === (effect.area ? 'region' : 'full')); });
      updateEffectFromControls('blur'); renderBlurRegion();
    }
    if (effect.kind === 'speed') {
      $$('#speed-control button').forEach((button) => { button.classList.toggle('is-active', Number(button.dataset.speed) === effect.rate); });
    }
    if (effect.kind === 'color') {
      $('#brightness-range').value = Math.round(effect.brightness * 100); $('#contrast-range').value = Math.round(effect.contrast * 100); $('#saturation-range').value = Math.round(effect.saturation * 100);
      updateEffectFromControls('color');
    }
    updateEffectClips();
  }
  function removeEffect(id) {
    const effect = state.effects.find((item) => item.id === id); if (!effect) return;
    state.deletedEffects.push({ ...effect, area: effect.area ? { ...effect.area } : null });
    state.effects = state.effects.filter((item) => item.id !== id);
    if (state.selectedEffect === id) state.selectedEffect = null;
    if (state.blurEffectId === id) { state.blurEffectId = null; state.blurVisible = false; $('#blur-region').hidden = true; }
    renderEffects(); updateOutputName();
  }
  function undoRemoveEffect() {
    const effect = state.deletedEffects.pop(); if (!effect) return;
    state.vfxTracks = Math.max(state.vfxTracks, effect.track + 1);
    if (hasOverlap(effect.kind, effect.track, effect.start, effect.end, effect.id)) {
      state.deletedEffects.push(effect); toast('Не удалось вернуть эффект: прежнее место занято.', 'warning'); return;
    }
    state.effects.push(effect); renderEffects(); selectEffect(effect.id); updateOutputName();
  }
  function updateEffectFromControls(kind) {
    const effect = selectedEffect(kind);
    if (kind === 'blur') {
      $('#blur-value').textContent = `${$('#blur-range').value} px`;
      if (effect) { effect.intensity = Number($('#blur-range').value); effect.area = state.blurVisible ? { ...state.blurRegion } : null; }
    }
    if (kind === 'color') {
      $('#brightness-value').textContent = $('#brightness-range').value; $('#contrast-value').textContent = `${$('#contrast-range').value}%`; $('#saturation-value').textContent = `${$('#saturation-range').value}%`;
      if (effect) Object.assign(effect, { brightness: Number($('#brightness-range').value) / 100, contrast: Number($('#contrast-range').value) / 100, saturation: Number($('#saturation-range').value) / 100 });
    }
    setRangeFill($(`#${kind === 'blur' ? 'blur' : 'brightness'}-range`)); updateEffectClips();
  }
  function syncEffectPlaybackRate() {
    const speed = effectAtPosition('speed'), rate = state.previewSpeed * (speed?.rate || 1);
    elements.video.playbackRate = rate; state.audioPlayers.forEach((player) => { player.audio.playbackRate = rate; });
    $('#preview-effect-rate').hidden = !speed || speed.rate === 1;
    if (speed) $('#preview-effect-rate').textContent = `${speed.rate}× VFX`;
  }
  function updateEffectPreview() {
    const color = effectAtPosition('color'), blurs = state.effects.filter((effect) => effect.kind === 'blur' && state.position >= effect.start && state.position < effect.end);
    const filters = [], fullBlur = blurs.filter((effect) => !effect.area).reduce((sum, effect) => sum + effect.intensity, 0);
    if (fullBlur) filters.push(`blur(${Math.min(12, fullBlur * .12)}px)`);
    if (color) filters.push(`brightness(${1 + color.brightness})`, `contrast(${color.contrast})`, `saturate(${color.saturation})`);
    elements.video.style.filter = filters.join(' ');
    const regionalBlurs = blurs.filter((effect) => effect.area);
    const primaryBlur = regionalBlurs.find((effect) => effect.id === state.blurEffectId) || regionalBlurs[0];
    const visible = regionalBlurs.length > 0;
    const region = $('#blur-region'); region.hidden = !visible;
    region.classList.toggle('is-preview', visible && selectedEffect('blur')?.id !== primaryBlur?.id);
    if (visible) {
      if (!state.playing) renderActiveBlurRegions();
      queueBlurPreviewFrame();
    } else {
      stopBlurPreviewUpdates();
    }
    syncEffectPlaybackRate();
  }
  function updateTimeline() {
    const duration = Math.max(state.duration, .001);
    elements.timeline.style.setProperty('--start', `${state.start / duration * 100}%`);
    elements.timeline.style.setProperty('--end', `${state.end / duration * 100}%`);
    elements.timeline.style.setProperty('--position', `${state.position / duration * 100}%`);
    $('#playback-current').textContent = formatTime(state.position, true);
    $('#playback-duration').textContent = formatTime(state.duration, true);
    $('#trim-start-time').textContent = `Начало ${formatTime(state.start, true)}`;
    $('#trim-end-time').textContent = `Конец ${formatTime(state.end, true)}`;
    $('#trim-length').textContent = `${(state.end - state.start).toFixed(1).replace('.', ',')} сек`;
    $('#frame-time-label').textContent = `Позиция ${formatTime(state.position, true)}`;
    $$('.timeline-ruler span').forEach((span, index) => { span.textContent = formatTime(state.duration * index / 4); });
    [[$('.trim-start'), state.start], [$('.trim-end'), state.end], [$('.playhead'), state.position]].forEach(([slider, value]) => {
      slider.setAttribute('aria-valuemax', state.duration.toFixed(2)); slider.setAttribute('aria-valuenow', value.toFixed(2)); slider.setAttribute('aria-valuetext', formatTime(value, true));
    });
    updateEffectClips();
  }
  function seek(value, fromVideo = false) {
    state.position = clamp(value, 0, state.duration);
    if (!fromVideo && !state.isDemo && Number.isFinite(elements.video.duration)) {
      state.audioPlayers.forEach((player) => player.audio.pause()); elements.video.currentTime = state.position;
    }
    updateTimeline();
    if (state.exportKind !== 'video' && $('#single-frame').checked) updateOutputName();
  }
  function scrubTo(value) { state.position = clamp(value, 0, state.duration); updateTimeline(); }
  function setPlaying(playing) {
    state.playing = playing;
    elements.centerPlay.classList.toggle('is-playing', playing); elements.playButton.classList.toggle('is-playing', playing);
    elements.centerPlay.innerHTML = icon(playing ? 'pause' : 'play'); elements.playButton.innerHTML = icon(playing ? 'pause' : 'play');
    elements.centerPlay.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести'); elements.playButton.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
  }
  function stopDemoPlayback() { if (state.demoFrame) cancelAnimationFrame(state.demoFrame); state.demoFrame = null; state.lastDemoTick = 0; }
  function tickDemo(timestamp) {
    if (!state.playing || !state.isDemo) return;
    if (!state.lastDemoTick) state.lastDemoTick = timestamp;
    const elapsed = (timestamp - state.lastDemoTick) / 1000 * state.previewSpeed * (effectAtPosition('speed')?.rate || 1); state.lastDemoTick = timestamp;
    if (state.position + elapsed >= state.end) { seek(state.start); setPlaying(false); return; }
    seek(state.position + elapsed); state.demoFrame = requestAnimationFrame(tickDemo);
  }
  async function togglePlayback() {
    if (state.playing) { if (state.isDemo) stopDemoPlayback(); else elements.video.pause(); setPlaying(false); return; }
    if (!state.isDemo && !elements.video.src) return;
    if (state.position >= state.end || state.position < state.start) seek(state.start);
    if (state.isDemo) { setPlaying(true); state.demoFrame = requestAnimationFrame(tickDemo); return; }
    try {
      if (elements.video.seeking) await new Promise((resolve) => elements.video.addEventListener('seeked', resolve, { once: true }));
      setPlaying(true);
      if (state.audioContext) await state.audioContext.resume();
      syncEffectPlaybackRate();
      await elements.video.play(); syncAudioPlayback();
    } catch { state.audioPlayers.forEach((player) => player.audio.pause()); setPlaying(false); toast('Не удалось запустить предпросмотр.', 'warning'); }
  }
  function syncPreviewAudio() {
    const audible = state.audio.length ? state.audio.some((track) => track.enabled && track.volume > 0) : true;
    if (state.audioPlayers.length) {
      elements.video.muted = true;
      state.audioPlayers.forEach((player) => {
        const track = state.audio.find((item) => item.index === player.index), volume = !state.masterMuted && track?.enabled ? track.volume : 0;
        if (player.gain) player.gain.gain.value = volume; else player.audio.volume = clamp(volume, 0, 1);
        player.audio.muted = volume === 0;
      });
    } else {
      const first = state.audio[0]; elements.video.volume = first?.enabled ? clamp(first.volume, 0, 1) : 1;
      elements.video.muted = state.masterMuted || Boolean(first && (!first.enabled || first.volume === 0));
    }
    $('#mute-button').innerHTML = icon(state.masterMuted || !audible ? 'muted' : 'volume');
    renderTimelineAudio();
  }
  function syncAudioPlayback() {
    state.audioPlayers.forEach((player) => {
      const audio = player.audio;
      if (state.scrubbing || elements.video.seeking) { audio.pause(); return; }
      if (Number.isFinite(audio.duration) && Math.abs(audio.currentTime - elements.video.currentTime) > .12) audio.currentTime = elements.video.currentTime;
      if (state.playing && !elements.video.paused) audio.play().catch(() => {}); else audio.pause();
    });
  }
  function clearAudioPlayers() {
    state.audioPlayers.forEach((player) => { player.audio.pause(); player.audio.removeAttribute('src'); player.audio.load(); player.source?.disconnect(); player.gain?.disconnect(); });
    state.audioPlayers = []; elements.video.muted = state.masterMuted;
  }
  function waitForMedia(media, token) {
    if (token !== state.loadToken) return Promise.resolve(false);
    if (media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const cleanup = () => { media.removeEventListener('canplay', ready); media.removeEventListener('error', failed); };
      const ready = () => { cleanup(); resolve(true); }, failed = () => { cleanup(); reject(new Error('Браузер не смог загрузить подготовленное превью.')); };
      media.addEventListener('canplay', ready, { once: true }); media.addEventListener('error', failed, { once: true });
    });
  }
  async function prepareAudioPlayers(previews, token) {
    clearAudioPlayers(); if (!previews.length) { syncPreviewAudio(); return token === state.loadToken; }
    const Context = window.AudioContext || window.webkitAudioContext;
    if (Context && !state.audioContext) state.audioContext = new Context();
    previews.forEach((preview) => {
      const audio = new Audio(); audio.preload = 'auto'; audio.crossOrigin = 'anonymous'; audio.src = preview.url;
      let source = null, gain = null;
      if (state.audioContext) { source = state.audioContext.createMediaElementSource(audio); gain = state.audioContext.createGain(); source.connect(gain); gain.connect(state.audioContext.destination); }
      state.audioPlayers.push({ index: preview.index, audio, source, gain });
    });
    syncPreviewAudio(); syncAudioPlayback();
    const readiness = await Promise.all(state.audioPlayers.map((player) => waitForMedia(player.audio, token)));
    return token === state.loadToken && readiness.every(Boolean);
  }
  function resetPlayback() {
    stopDemoPlayback(); state.scrubbing = false; state.resumeAfterScrub = false; elements.video.pause(); clearAudioPlayers(); setPlaying(false); state.position = 0;
  }
  function clearThumbnails() {
    const container = $('.timeline-thumbnails'); container.textContent = '';
    for (let index = 0; index < 12; index++) { const span = document.createElement('span'); span.dataset.index = index; container.append(span); }
  }
  function resetEffects() {
    state.effects = []; state.deletedEffects = []; state.vfxTracks = 2; state.selectedEffect = null; state.blurEffectId = null; state.blurVisible = false;
    $$('details[data-effect]').forEach((details) => { details.open = false; });
    $('#blur-range').value = 24; $('#brightness-range').value = 0; $('#contrast-range').value = 100; $('#saturation-range').value = 100;
    $$('#blur-range, #brightness-range, #contrast-range, #saturation-range').forEach(setRangeFill);
    updateEffectFromControls('blur'); updateEffectFromControls('color'); renderEffects();
  }
  function populateMedia(info) {
    state.media = info; state.isDemo = false; state.duration = Math.max(info.duration, .001); state.start = 0; state.end = state.duration; state.position = 0;
    state.originalWidth = info.width; state.originalHeight = info.height; state.audio = info.audio.map((track) => ({ ...track, enabled: true, volume: 1 }));
    $('#header-file-name').textContent = info.name; $('#clip-file-name').textContent = info.name;
    $('#header-file-meta').textContent = `${info.name.split('.').pop().toUpperCase()} · ${formatFileSize(info.size)} · ${info.width} × ${info.height} · ${info.fps.toFixed(info.fps % 1 ? 2 : 0)} FPS`;
    $('#preview-file-label').textContent = info.name; $('#workspace-mode').textContent = 'Подготовка превью…';
    $('#preview-resolution').textContent = `${info.width} × ${info.height}`;
    $('#preview-codec').textContent = `${info.codec.toUpperCase()} · ${info.fps ? info.fps.toFixed(info.fps % 1 ? 2 : 0) : '—'} FPS`;
    elements.poster.hidden = true; elements.video.hidden = false;
    $('#width-input').value = String(info.width); $('#height-input').value = String(info.height);
    $('#resolution-summary').textContent = `Как в оригинале · ${info.width} × ${info.height}`;
    $$('#resolution-presets button').forEach((button) => button.classList.toggle('active', button.textContent === 'Оригинал'));
    resetEffects(); setCropRatio('free'); renderAudioTracks(); clearThumbnails();
    elements.welcome.hidden = true; elements.workspace.hidden = false; updateOutputName(); updateTimeline();
  }
  function openWorkspace(file = null) {
    resetPlayback(); state.loadToken += 1; $('#workbench-loading').hidden = true; $('.workbench').setAttribute('aria-busy', 'false');
    state.media = null; state.isDemo = !file; state.duration = 41; state.start = 0; state.end = 41; state.position = 0; state.originalWidth = 1920; state.originalHeight = 1080;
    const demoAudio = [
      { index: 1, number: 1, name: 'Основная дорожка', language: 'Русский', codec: 'AAC', channels: 2, sampleRate: 48000, bitRate: 192000 },
      { index: 2, number: 2, name: 'Комментарии', language: 'English', codec: 'AAC', channels: 2, sampleRate: 48000, bitRate: 160000 }
    ];
    if (!file) { state.media = { name: 'Showreel_2026.mp4', size: 50500000, audio: demoAudio }; state.audio = demoAudio.map((track) => ({ ...track, enabled: true, volume: 1 })); } else state.audio = [];
    const name = file ? file.name : 'Showreel_2026.mp4';
    $('#header-file-name').textContent = name; $('#clip-file-name').textContent = name;
    $('#header-file-meta').textContent = file ? `${name.split('.').pop().toUpperCase()} · ${formatFileSize(file.size)}` : 'MP4 · 48,2 МБ';
    $('#preview-file-label').textContent = name; $('#workspace-mode').textContent = file ? 'Браузерный предпросмотр' : 'Демо-режим';
    $('#preview-resolution').textContent = '1920 × 1080'; $('#preview-codec').textContent = file ? 'ЛОКАЛЬНЫЙ ФАЙЛ' : 'H.264 · 30 FPS';
    elements.poster.hidden = Boolean(file); elements.video.hidden = !file;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; elements.video.removeAttribute('src'); elements.video.load();
    if (file) { state.objectUrl = URL.createObjectURL(file); elements.video.src = state.objectUrl; elements.video.load(); }
    $('#width-input').value = '1920'; $('#height-input').value = '1080'; $('#resolution-summary').textContent = 'Как в оригинале · 1920 × 1080';
    resetEffects(); setCropRatio('free'); renderAudioTracks(); clearThumbnails(); elements.welcome.hidden = true; elements.workspace.hidden = false; updateOutputName(); updateTimeline();
  }
  function showWorkbenchLoading(status) {
    $('#loading-title').textContent = 'Подготовка видео'; $('#loading-status').textContent = status; $('#loading-actions').hidden = true;
    $('#workbench-loading').classList.remove('is-error'); $('#workbench-loading').hidden = false; $('.workbench').setAttribute('aria-busy', 'true'); $('#workspace-mode').textContent = 'Подготовка видео…';
  }
  function showLoadingError(message) {
    $('#loading-title').textContent = 'Не удалось открыть видео'; $('#loading-status').textContent = message; $('#loading-actions').hidden = false;
    $('#workbench-loading').classList.add('is-error'); $('#workbench-loading').hidden = false; $('.workbench').setAttribute('aria-busy', 'false'); $('#workspace-mode').textContent = 'Ошибка открытия';
  }
  async function loadThumbnails(urls, token) {
    await Promise.all(urls.map((url) => new Promise((resolve, reject) => { const image = new Image(); image.onload = resolve; image.onerror = () => reject(new Error('Не удалось загрузить кадры таймлайна.')); image.src = url; })));
    if (token !== state.loadToken) return false;
    $$('.timeline-thumbnails span').forEach((span, index) => { if (urls[index]) { span.style.backgroundImage = `linear-gradient(180deg, transparent 55%, rgba(5,6,9,.55)), url("${urls[index]}")`; span.style.backgroundSize = '100% 100%'; } });
    return true;
  }
  async function openMediaPath(path) {
    const token = ++state.loadToken; resetPlayback(); $('#workspace-mode').textContent = 'Открытие файла…';
    try {
      const info = await invoke('open_media', { path }); if (token !== state.loadToken) return;
      populateMedia(info); showWorkbenchLoading('Загрузка превью…'); elements.video.removeAttribute('src'); elements.video.load();
      const preview = await invoke('prepare_preview', { path }); if (token !== state.loadToken) return;
      elements.video.src = preview.url; elements.video.load(); if (!await waitForMedia(elements.video, token) || token !== state.loadToken) return;
      showWorkbenchLoading('Создание кадров таймлайна…');
      const urls = await invoke('generate_thumbnails', { path }); if (token !== state.loadToken) return; if (!await loadThumbnails(urls, token) || token !== state.loadToken) return;
      showWorkbenchLoading(info.audio.length ? 'Подготовка звуковых дорожек…' : 'Завершение подготовки…');
      const previews = info.audio.length ? await invoke('prepare_audio_previews', { path }) : []; if (token !== state.loadToken) return;
      if (!await prepareAudioPlayers(previews, token) || token !== state.loadToken) return;
      $('#workbench-loading').hidden = true; $('.workbench').setAttribute('aria-busy', 'false');
      $('#workspace-mode').textContent = preview.proxied ? 'Превью H.264 · экспорт из оригинала' : 'Файл открыт';
    } catch (error) {
      if (token !== state.loadToken) return; const message = String(error); toast(message, 'error', { duration: 7000 });
      if (elements.workspace.hidden) showWelcome(); else showLoadingError(message);
    }
  }
  function showWelcome() {
    state.loadToken += 1; resetPlayback(); $('#workbench-loading').hidden = true; $('.workbench').setAttribute('aria-busy', 'false'); elements.workspace.hidden = true; elements.welcome.hidden = false;
  }
  async function openFiles() {
    if (desktop) { try { const path = await api.dialog.open({ multiple: false, directory: false, filters: videoFilters }); if (path) openMediaPath(path); } catch (error) { toast(String(error), 'error'); } }
    else elements.fileInput.click();
  }
  function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith('video/') && !/\.(mp4|mkv|mov|avi|webm|m4v|wmv|flv|ts|m2ts)$/i.test(file.name)) { toast('Выберите видеофайл.', 'error'); return; }
    openWorkspace(file);
  }

  function updatePresetLabels() {
    $$('#preset-grid button').forEach((button) => {
      const preset = presets[button.dataset.preset]; if (!preset) return;
      const supported = !state.encoderSupport || (preset.codec === 'AV1' ? state.encoderSupport.nvidiaAv1 : state.encoderSupport.nvidia);
      const encoder = supported ? preset.encoder : 'CPU'; $('small', button).textContent = `${preset.codec} · ${encoder} · ${encoder === 'CPU' ? 'CRF' : 'CQ'} ${preset.quality}`;
    });
  }
  function updateEncoderOptions() {
    if (!state.encoderSupport) return;
    const nvidia = Array.from(elements.encoder.options).find((option) => option.value === 'NVIDIA NVENC'), intel = Array.from(elements.encoder.options).find((option) => option.value === 'Intel Quick Sync');
    if (nvidia) nvidia.disabled = !state.encoderSupport.nvidia || (elements.codec.value === 'AV1' && !state.encoderSupport.nvidiaAv1);
    if (intel) intel.disabled = !state.encoderSupport.intel;
    updatePresetLabels(); syncCombobox(elements.encoder);
  }
  function updateQuality() {
    const value = Number(elements.quality.value), label = value <= 20 ? 'Очень высокое' : value <= 25 ? 'Высокое' : value <= 30 ? 'Среднее' : 'Компактное';
    $('#quality-value').textContent = `${elements.encoder.value === 'CPU' ? 'CRF' : 'CQ'} ${value} · ${label}`; setRangeFill(elements.quality);
  }
  function updateCompressionSummary(presetName = null) {
    const active = presetName || $('#preset-grid button.is-active')?.dataset.preset;
    $('#compression-summary').textContent = `${presets[active]?.label || 'Пользовательский'} · ${elements.codec.value}`; updateOutputName(); scheduleSave();
  }
  function selectPreset(name, persist = true) {
    const preset = presets[name]; if (!preset) return;
    $$('#preset-grid button').forEach((button) => button.classList.toggle('is-active', button.dataset.preset === name));
    elements.codec.value = preset.codec; updateEncoderOptions(); elements.encoder.value = preset.encoder;
    if (elements.encoder.selectedOptions[0]?.disabled) { elements.encoder.value = 'CPU'; toast('Аппаратный кодировщик недоступен, выбран CPU.', 'warning'); }
    elements.quality.value = preset.quality; syncCombobox(elements.codec); syncCombobox(elements.encoder); updateQuality(); if (persist) updateCompressionSummary(name);
  }
  function markCustomPreset() { $$('#preset-grid button').forEach((button) => button.classList.remove('is-active')); updateCompressionSummary(); }

  function renderUpdate(info) {
    state.update = info;
    $('#update-status').textContent = info.downloading ? `Скачивание версии ${info.latestVersion}…` : info.downloaded ? `Версия ${info.latestVersion} готова к установке` : info.available ? `Доступна версия ${info.latestVersion}` : `Установлена последняя версия · ${info.currentVersion}`;
    $('#update-check').textContent = info.downloaded ? 'Установить' : info.available ? 'Обновить' : 'Проверить'; $('#update-check').disabled = info.downloading; $('#update-progress').hidden = !info.downloading;
    if (!info.downloading) { $('#update-progress-bar').style.width = '0%'; $('#update-progress-value').textContent = '0%'; }
  }
  function showUpdateAvailable() {
    const info = state.update; if (!info?.available || state.updatePromptShown) return; state.updatePromptShown = true;
    $('#update-modal-eyebrow').textContent = info.downloaded ? 'Обновление готово' : 'Доступно обновление';
    $('#update-version-label').textContent = `Версия ${info.currentVersion} → ${info.latestVersion}`; $('#update-notes').textContent = info.notes.trim() || 'Настройки и файлы кэша будут сохранены.';
    $('#update-install').disabled = Boolean(state.activeJob); $('#update-install').textContent = state.activeJob ? 'Дождитесь завершения экспорта' : info.downloaded ? 'Обновить и перезапустить' : 'Скачать и установить';
    $('#update-modal-progress').hidden = true; openModal(elements.updateModal);
  }
  async function installDownloadedUpdate() {
    if (!state.update?.downloaded) return; if (state.activeJob) { toast('Дождитесь завершения экспорта.', 'warning'); return; }
    $('#update-install').disabled = true; try { await invoke('install_update'); } catch (error) { $('#update-install').disabled = false; toast(String(error), 'error', { duration: 7000 }); }
  }
  async function downloadUpdate(installAfter = false) {
    if (state.updateBusy || !state.update?.available) return;
    if (state.update.downloaded) { if (installAfter) await installDownloadedUpdate(); return; }
    state.updateBusy = true; renderUpdate({ ...state.update, downloading: true });
    if (installAfter) { $('#update-modal-progress').hidden = false; $('#update-install').disabled = true; $('#update-install').textContent = 'Скачивание…'; }
    try { const info = await invoke('download_update'); renderUpdate(info); if (installAfter) await installDownloadedUpdate(); else showUpdateAvailable(); }
    catch (error) { $('#update-status').textContent = String(error); $('#update-progress').hidden = true; $('#update-modal-progress').hidden = true; $('#update-check').disabled = false; $('#update-install').disabled = false; $('#update-install').textContent = 'Повторить'; toast(String(error), 'error', { duration: 7000 }); }
    finally { state.updateBusy = false; }
  }
  async function checkForUpdates(manual = false) {
    if (state.updateBusy) return; if (state.update?.available) { showUpdateAvailable(); return; }
    state.updateBusy = true; $('#update-check').disabled = true; $('#update-status').textContent = 'Проверка обновлений…';
    try { const info = await invoke('check_for_updates'); state.updateBusy = false; renderUpdate(info); if (info.available) showUpdateAvailable(); else if (manual) toast('Установлена последняя версия.', 'success'); }
    catch (error) { $('#update-status').textContent = 'Не удалось проверить обновления. Повторите попытку позже.'; $('#update-check').disabled = false; if (manual) toast(String(error), 'error', { duration: 6000 }); }
    finally { state.updateBusy = false; if (!state.update?.downloading) $('#update-check').disabled = false; }
  }
  function openModal(modal) {
    if (modal !== elements.exportModal && !elements.exportModal.hidden) state.restoreExportModal = true;
    modal.hidden = false; $('[data-close-modal]', modal)?.focus();
  }
  function closeModals() {
    const restoreExport = state.restoreExportModal;
    elements.exportModal.hidden = !restoreExport; elements.helpModal.hidden = true; elements.updateModal.hidden = true;
    state.restoreExportModal = false; state.updatePromptShown = false;
    if (restoreExport) $('[data-close-modal]', elements.exportModal)?.focus();
  }
  function resetTrim() { state.start = 0; state.end = state.duration; seek(0); updateTimeline(); updateOutputName(); }

  function videoRect() {
    const rect = $('#preview-stage').getBoundingClientRect(), aspect = state.originalWidth / state.originalHeight;
    let width = rect.width, height = width / aspect; if (height > rect.height) { height = rect.height; width = height * aspect; }
    return { left: (rect.width - width) / 2, top: (rect.height - height) / 2, width, height };
  }
  function positionFrame(frame, region) {
    const rect = videoRect(); frame.style.left = `${rect.left + region.x * rect.width}px`; frame.style.top = `${rect.top + region.y * rect.height}px`;
    frame.style.width = `${region.width * rect.width}px`; frame.style.height = `${region.height * rect.height}px`;
  }
  function renderCrop() {
    if (!state.crop) return; positionFrame($('.crop-frame'), state.crop);
    const width = Math.round(state.crop.width * state.originalWidth) & ~1, height = Math.round(state.crop.height * state.originalHeight) & ~1;
    $('#crop-summary').textContent = sectionOpen('crop') ? `${width} × ${height} · ${state.cropRatio}` : 'Не применяется'; $('.crop-label').textContent = `${width} × ${height} · перетащите рамку`;
  }
  function setCropRatio(ratio) {
    state.cropRatio = ratio; $$('#ratio-grid button').forEach((button) => button.classList.toggle('active', button.dataset.ratio === ratio));
    if (ratio === 'free') { state.crop = null; state.cropVisible = false; elements.cropOverlay.hidden = true; $('#crop-preview-button').innerHTML = `${icon('crop')}Область на превью`; ensurePreciseForTransforms(); updateOutputName(); return; }
    const [rx, ry] = ratio.split(':').map(Number), target = rx / ry, source = state.originalWidth / state.originalHeight;
    let width = .8, height = width * source / target; if (height > .8) { height = .8; width = height * target / source; }
    state.crop = { x: (1 - width) / 2, y: (1 - height) / 2, width, height }; state.cropVisible = true;
    elements.cropOverlay.hidden = !sectionOpen('crop'); $('#crop-preview-button').innerHTML = `${icon('crop')}Скрыть область на превью`;
    requestAnimationFrame(renderCrop); ensurePreciseForTransforms(); updateOutputName();
  }
  function setupRegionDrag(frame, getRegion, onChange, handlePrefix) {
    let drag = null;
    frame.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const region = getRegion(); if (!region) return;
      const handle = event.target.closest(`.${handlePrefix}`), mode = handle ? ['tl', 'tr', 'bl', 'br'].find((name) => handle.classList.contains(`bh-${name}`) || handle.classList.contains(`ch-${name}`)) : 'move';
      drag = { mode, x: event.clientX, y: event.clientY, region: { ...region }, rect: videoRect() }; frame.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
    });
    frame.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const dx = (event.clientX - drag.x) / drag.rect.width, dy = (event.clientY - drag.y) / drag.rect.height, original = drag.region, min = .04;
      let next = { ...original };
      if (drag.mode === 'move') { next.x = clamp(original.x + dx, 0, 1 - original.width); next.y = clamp(original.y + dy, 0, 1 - original.height); }
      else {
        let left = original.x, right = original.x + original.width, top = original.y, bottom = original.y + original.height;
        if (['tl', 'bl'].includes(drag.mode)) left = clamp(left + dx, 0, right - min);
        if (['tr', 'br'].includes(drag.mode)) right = clamp(right + dx, left + min, 1);
        if (['tl', 'tr'].includes(drag.mode)) top = clamp(top + dy, 0, bottom - min);
        if (['bl', 'br'].includes(drag.mode)) bottom = clamp(bottom + dy, top + min, 1);
        next = { x: left, y: top, width: right - left, height: bottom - top };
      }
      onChange(next);
    });
    const stop = (event) => { drag = null; if (frame.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId); };
    frame.addEventListener('pointerup', stop); frame.addEventListener('pointercancel', stop);
  }
  function renderAudioTracks() {
    $$('#audio-panel .audio-track').forEach((track) => track.remove());
    const output = $('.audio-output');
    state.audio.forEach((track) => {
      const article = document.createElement('article'); article.className = `audio-track${track.enabled ? '' : ' disabled'}`; article.dataset.index = track.index;
      const channels = track.channels === 1 ? 'Mono' : track.channels === 2 ? 'Stereo' : `${track.channels} каналов`, details = [track.language, track.codec, channels].filter(Boolean).join(' · ');
      article.innerHTML = `<div class="audio-track-head"><span class="track-number">A${track.number}</span><div><strong>${escapeHtml(track.name)}</strong><span>${escapeHtml(details)}</span></div><label class="m-switch"><input class="track-enabled" type="checkbox" ${track.enabled ? 'checked' : ''} aria-label="Включить дорожку ${track.number}"><span></span></label></div><div class="track-volume">${icon('volume')}<input class="m-range audio-volume" type="range" min="0" max="200" value="${Math.round(track.volume * 100)}" aria-label="Громкость дорожки ${track.number}"><span>${Math.round(track.volume * 100)}%</span></div><div class="track-footer"><span>${track.sampleRate ? `${(track.sampleRate / 1000).toFixed(1).replace('.0', '')} kHz` : 'Частота не указана'}${track.bitRate ? ` · ${Math.round(track.bitRate / 1000)} kb/s` : ''}</span><button class="text-button track-mute" type="button">${track.volume ? 'Выключить звук' : 'Вернуть громкость'}</button></div>`;
      output.before(article);
      const enabled = $('.track-enabled', article), volume = $('.audio-volume', article); setRangeFill(volume);
      enabled.addEventListener('change', () => { track.enabled = enabled.checked; article.classList.toggle('disabled', !track.enabled); syncPreviewAudio(); updateOutputName(); });
      volume.addEventListener('input', () => { track.volume = Number(volume.value) / 100; setRangeFill(volume); $('.track-volume > span', article).textContent = `${volume.value}%`; $('.track-mute', article).textContent = track.volume ? 'Выключить звук' : 'Вернуть громкость'; syncPreviewAudio(); });
      $('.track-mute', article).addEventListener('click', () => { volume.value = track.volume ? 0 : 100; volume.dispatchEvent(new Event('input')); });
    });
    $('.tab-count').textContent = state.audio.length; $('.audio-overview .m-badge').textContent = `${state.audio.length} дорожек`; $('.audio-overview').hidden = state.audio.length === 0;
    if (!state.audio.length) { const empty = document.createElement('div'); empty.className = 'm-help audio-track'; empty.textContent = 'В исходном файле нет аудиодорожек.'; output.before(empty); }
    syncPreviewAudio();
  }
  function renderTimelineAudio() {
    $('#audio-labels').textContent = ''; $('#audio-rows').textContent = '';
    $('#effect-count').textContent = `${activeEffects().length} эффектов · ${state.audio.length} аудиодорожек`;
    updateTimelineLayout();
  }
  function resetSettings() {
    selectPreset('balance'); elements.container.value = 'MP4'; $('#width-input').value = String(state.originalWidth); $('#height-input').value = String(state.originalHeight);
    $$('#resolution-presets button').forEach((button) => button.classList.toggle('active', button.textContent === 'Оригинал'));
    $$('#video-panel > .setting-section').forEach((section) => { section.open = false; }); $('#video-tab').click();
    setCropRatio('free'); resetTrim(); setTrimMode('precise'); resetEffects();
    state.audio.forEach((track) => { track.enabled = true; track.volume = 1; }); renderAudioTracks();
    $('#audio-codec').value = 'aac'; $('#audio-bitrate').value = '192'; $('#keep-metadata').checked = true; $('#keep-subtitles').checked = true; $('.audio-output').open = false;
    setExportKind('video'); syncAllComboboxes(); updateAudioSummary(); updateOutputName(); scheduleSave(); toast('Настройки сброшены.', 'success');
  }
  function updateAudioSummary() {
    const codec = $('#audio-codec').value, bitrate = ['flac', 'wav'].includes(codec) ? '' : ` · ${$('#audio-bitrate').value} kb/s`;
    $('.audio-output summary small').textContent = $('.audio-output').open ? `${$('#audio-codec').selectedOptions[0].textContent}${bitrate}` : 'Не применяется';
    $('#audio-bitrate').disabled = ['flac', 'wav'].includes(codec); syncCombobox($('#audio-bitrate')); updateOutputName(); scheduleSave();
  }
  function setExportKind(kind) {
    state.exportKind = kind;
    $('#export-kind-select').value = kind;
    syncCombobox($('#export-kind-select'));
    $$('#image-format button').forEach((button) => { button.classList.toggle('active', button.dataset.format.toLowerCase() === kind); button.classList.toggle('is-active', button.dataset.format.toLowerCase() === kind); });
    const audioCodec = $('#audio-codec'); let wav = $('option[value="wav"]', audioCodec);
    if (kind === 'audio') {
      if (wav) { wav.hidden = false; wav.disabled = false; }
      if (audioCodec.value === 'original') audioCodec.value = 'mp3'; $('.audio-output').open = true; $('#audio-tab').click();
    } else {
      if (audioCodec.value === 'wav') audioCodec.value = 'aac';
      if (wav) { wav.hidden = true; wav.disabled = true; }
    }
    $('#single-frame').disabled = kind === 'gif' || kind === 'audio'; if (kind === 'gif') $('#single-frame').checked = false;
    $('#fps-range').disabled = !(kind === 'gif' || (['png', 'jpg'].includes(kind) && !$('#single-frame').checked));
    $('#fps-value').textContent = $('#fps-range').disabled ? 'Для GIF и серии' : `${$('#fps-range').value} FPS`;
    elements.container.disabled = kind !== 'video'; $$('#trim-mode button').forEach((button) => { button.disabled = kind !== 'video'; });
    $('.audio-overview div span').textContent = kind === 'audio' ? 'Выбранные дорожки будут смешаны в одну' : 'Настройте каждую дорожку отдельно';
    syncAllComboboxes(); updateAudioSummary();
  }
  function exportSettings(output) {
    const options = videoOptions(), singleImage = ['png', 'jpg'].includes(state.exportKind) && $('#single-frame').checked;
    return {
      input: state.media.path, output, kind: state.exportKind, start: singleImage ? state.position : state.start, end: singleImage ? state.position + .001 : state.end,
      copyVideo: options.copyVideo, codec: options.codec, encoder: options.encoder, quality: options.quality,
      width: clamp(options.width, 16, 16384), height: clamp(options.height, 16, 16384), originalWidth: state.originalWidth, originalHeight: state.originalHeight,
      crop: options.crop, fps: Number($('#fps-range').value), singleFrame: $('#single-frame').checked,
      audio: state.audio.map((track) => ({ index: track.index, enabled: track.enabled, volume: track.volume })),
      audioCodec: options.audioCodec, audioBitrate: Number($('#audio-bitrate').value), keepMetadata: options.keepMetadata, keepSubtitles: options.keepSubtitles,
      effects: options.effects.map((effect) => ({ ...effect, start: effect.start - state.start, end: effect.end - state.start }))
    };
  }
  function showExportProgress(name) {
    $('#export-modal-title').textContent = 'Экспорт'; $('#export-modal-eyebrow').textContent = 'FFmpeg'; $('#export-modal-message').textContent = 'Обработка файла…'; $('#export-modal-icon').innerHTML = icon('film');
    $('#export-progress').hidden = false; $('#export-progress-bar').style.width = '0%'; $('#export-progress-value').textContent = '0%'; $('#review-file').textContent = name;
    const options = videoOptions(), format = options.copyVideo ? 'Без перекодирования' : options.compression ? options.codec : `Авто · ${options.codec}`;
    $('#review-format').textContent = state.exportKind === 'video' ? `${options.extension.toUpperCase()} · ${format}` : currentExtension().toUpperCase(); $('#review-trim').textContent = `${formatTime(state.start)} — ${formatTime(state.end)}`;
    $('#cancel-export').hidden = false; $('#cancel-export').disabled = false; $('#reveal-result').hidden = true; $('#export-done').hidden = true; openModal(elements.exportModal);
  }
  async function startExport() {
    if (state.activeJob) return;
    if (!desktop || state.isDemo || !state.media?.path) { toast('Для экспорта откройте видео в приложении FFConverter.', 'warning'); return; }
    if (state.end <= state.start) { toast('Выберите фрагмент на таймлайне.', 'warning'); return; }
    if (state.exportKind === 'audio' && !selectedAudioTracks().length) { toast('Выберите хотя бы одну аудиодорожку.', 'warning'); return; }
    let output; const extension = currentExtension(), sequence = ['png', 'jpg'].includes(state.exportKind) && !$('#single-frame').checked;
    try { output = sequence ? await api.dialog.open({ directory: true, multiple: false, title: 'Папка для последовательности кадров' }) : await api.dialog.save({ title: 'Сохранить результат', defaultPath: outputName(), filters: [{ name: extension.toUpperCase(), extensions: [extension] }] }); }
    catch (error) { toast(String(error), 'error'); return; }
    if (!output) return; state.exportOutput = output; showExportProgress(sequence ? `Кадры ${extension.toUpperCase()}` : output.split(/[\\/]/).pop());
    try { state.activeJob = await invoke('start_export', { settings: exportSettings(output) }); updateOutputName(); }
    catch (error) { state.activeJob = null; $('#export-modal-title').textContent = 'Не удалось начать экспорт'; $('#export-modal-message').textContent = String(error); $('#export-progress').hidden = true; $('#cancel-export').hidden = true; $('#export-done').hidden = false; updateOutputName(); }
  }
  function finishExport(event) {
    if (event.jobId !== state.activeJob) return; state.activeJob = null;
    $('#export-progress').hidden = true; $('#cancel-export').hidden = true; $('#export-done').hidden = false;
    const done = event.status === 'done'; if (done && event.output) state.exportOutput = event.output;
    $('#export-modal-title').textContent = done ? 'Готово' : event.status === 'cancelled' ? 'Экспорт отменён' : 'Ошибка экспорта'; $('#export-modal-eyebrow').textContent = done ? 'Файл сохранён' : 'FFmpeg';
    $('#export-modal-message').textContent = event.message; $('#export-modal-icon').innerHTML = icon(done ? 'check' : event.status === 'cancelled' ? 'close' : 'info'); $('#reveal-result').hidden = !done;
    if (state.update?.downloaded) { $('#update-install').disabled = false; $('#update-install').textContent = 'Обновить и перезапустить'; } updateOutputName();
  }
  function scheduleSave() {
    if (!desktop || !state.settingsReady) return; clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      const settings = { codec: elements.codec.value, encoder: elements.encoder.value, quality: Number(elements.quality.value), container: elements.container.value, audioCodec: $('#audio-codec').value, audioBitrate: Number($('#audio-bitrate').value), accentColor: $('#accent-color').value, contextMenu: Boolean(state.settings.contextMenu) };
      state.settings = { ...state.settings, ...settings }; invoke('save_settings', { settings: state.settings }).catch(() => {});
    }, 350);
  }

  function syncCombobox(select) {
    if (!select?.id) return;
    const combo = $(`[data-for-select="${select.id}"]`); if (!combo) return;
    const value = $('.m-combobox-value', combo), list = $('[role="listbox"]', combo), trigger = $('.m-combobox-trigger', combo);
    value.textContent = select.selectedOptions[0]?.textContent || select.options[0]?.textContent || '—';
    Array.from(list.children).forEach((option, index) => {
      const source = select.options[index], selected = source?.value === select.value;
      option.setAttribute('aria-selected', String(selected)); option.disabled = Boolean(source?.disabled || select.disabled);
      option.hidden = !source || source.hidden;
    });
    trigger.disabled = select.disabled; trigger.setAttribute('aria-disabled', String(select.disabled));
  }
  function syncAllComboboxes() { $$('select.m-select').forEach(syncCombobox); }
  function replaceNativeSelects() {
    $$('select.m-select').forEach((select) => {
      if (!select.id) select.id = `select-${Math.random().toString(36).slice(2)}`;
      const label = select.getAttribute('aria-label') || select.closest('.m-field')?.querySelector('.m-label')?.textContent || 'Выбор';
      const combo = document.createElement('div'); combo.className = `m-combobox ${select.id === 'preview-speed' ? 'playback-speed-combobox' : ''}`; combo.dataset.combobox = ''; combo.dataset.forSelect = select.id;
      combo.innerHTML = `<button class="m-combobox-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="${escapeHtml(label)}"><span class="m-combobox-value"></span><svg class="m-icon"><use href="#i-chevron"/></svg></button><div class="m-combobox-list" role="listbox" aria-label="${escapeHtml(label)}"></div>`;
      const list = $('[role="listbox"]', combo);
      Array.from(select.options).forEach((option) => { const item = document.createElement('button'); item.className = 'm-combobox-option'; item.type = 'button'; item.setAttribute('role', 'option'); item.dataset.value = option.value; item.innerHTML = `<span>${escapeHtml(option.textContent)}</span>${icon('check').replace('class="m-icon"', 'class="m-icon m-combobox-selected-icon"')}`; list.append(item); });
      select.classList.add('select-proxy'); select.after(combo); syncCombobox(select);
      combo.addEventListener('mono:change', (event) => {
        const option = event.target.closest?.('[role="option"]');
        const selected = option || $$('[role="option"]', combo).find((item) => item.getAttribute('aria-selected') === 'true');
        if (!selected || selected.disabled || select.disabled) return;
        select.value = selected.dataset.value; select.dispatchEvent(new Event('change', { bubbles: true })); syncCombobox(select);
      });
      select.addEventListener('change', () => syncCombobox(select));
    });
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('.m-combobox-trigger'); if (!trigger) return;
      const combo = trigger.closest('.m-combobox'), rect = combo.getBoundingClientRect(), below = window.innerHeight - rect.bottom;
      combo.classList.toggle('is-upward', below < 190 && rect.top > below);
      const section = combo.closest('.effect-section'); if (section) section.style.overflow = 'visible';
      $$('.effect-section').forEach((item) => { if (!item.querySelector('.m-combobox.is-open')) item.style.removeProperty('overflow'); });
    });
  }
  function createCustomScrollbar(element, className) {
    if (!element || element.dataset.customScroll) return;
    const wrapper = document.createElement('div'); wrapper.className = `custom-scroll-wrap ${className}`; element.parentElement.insertBefore(wrapper, element); wrapper.append(element);
    element.dataset.customScroll = 'true';
    const rail = document.createElement('div'), thumb = document.createElement('button'); rail.className = 'custom-scroll-rail'; thumb.className = 'custom-scroll-thumb'; thumb.type = 'button'; thumb.tabIndex = -1; thumb.setAttribute('aria-label', 'Прокрутка'); rail.append(thumb); wrapper.append(rail);
    const update = () => {
      const available = element.clientHeight; rail.hidden = element.scrollHeight <= available + 1; if (rail.hidden) return;
      const thumbHeight = Math.max(24, available * available / element.scrollHeight), top = (element.scrollTop / (element.scrollHeight - available)) * (available - thumbHeight);
      thumb.style.height = `${thumbHeight}px`; thumb.style.transform = `translateY(${top}px)`;
    };
    element.addEventListener('scroll', update); new ResizeObserver(update).observe(wrapper); new ResizeObserver(update).observe(element);
    thumb.addEventListener('pointerdown', (event) => {
      const startY = event.clientY, startScroll = element.scrollTop; thumb.setPointerCapture(event.pointerId);
      const move = (moveEvent) => { const ratio = (element.scrollHeight - element.clientHeight) / Math.max(1, element.clientHeight - thumb.offsetHeight); element.scrollTop = startScroll + (moveEvent.clientY - startY) * ratio; };
      const stop = () => { thumb.removeEventListener('pointermove', move); thumb.removeEventListener('pointerup', stop); thumb.removeEventListener('pointercancel', stop); };
      thumb.addEventListener('pointermove', move); thumb.addEventListener('pointerup', stop); thumb.addEventListener('pointercancel', stop); event.preventDefault();
    });
    update();
  }

  function hsvHex(hsv) {
    const c = hsv.v * hsv.s, x = c * (1 - Math.abs((hsv.h / 60) % 2 - 1)), m = hsv.v - c;
    const values = hsv.h < 60 ? [c, x, 0] : hsv.h < 120 ? [x, c, 0] : hsv.h < 180 ? [0, c, x] : hsv.h < 240 ? [0, x, c] : hsv.h < 300 ? [x, 0, c] : [c, 0, x];
    return `#${values.map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('')}`;
  }
  function drawColorField() {
    const { h, s, v } = state.colorHsv, surface = $('#color-field');
    surface.style.setProperty('--m-picker-hue', h);
    $('#accent-cursor').style.left = `${s * 100}%`; $('#accent-cursor').style.top = `${(1 - v) * 100}%`;
    surface.setAttribute('aria-valuenow', String(Math.round(s * 100)));
    surface.setAttribute('aria-valuetext', `Насыщенность ${Math.round(s * 100)}%, яркость ${Math.round(v * 100)}%`);
  }
  function setupColorPicker() {
    const button = $('#accent-picker-button'), picker = $('#color-picker'), surface = $('#color-field');
    const setOpen = (open) => { picker.hidden = !open; button.setAttribute('aria-expanded', String(open)); button.closest('.docs-color-picker').classList.toggle('is-open', open); if (open) drawColorField(); };
    button.addEventListener('click', () => setOpen(picker.hidden));
    let dragging = false;
    const update = (event) => {
      const rect = surface.getBoundingClientRect();
      state.colorHsv.s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      state.colorHsv.v = 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1);
      applyAccent(hsvHex(state.colorHsv)); scheduleSave();
    };
    surface.addEventListener('pointerdown', (event) => { dragging = true; surface.setPointerCapture(event.pointerId); update(event); event.preventDefault(); });
    surface.addEventListener('pointermove', (event) => { if (dragging) update(event); });
    const stop = (event) => { dragging = false; if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId); };
    surface.addEventListener('pointerup', stop); surface.addEventListener('pointercancel', stop);
    surface.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? .1 : .02;
      if (event.key === 'ArrowLeft') state.colorHsv.s = clamp(state.colorHsv.s - step, 0, 1);
      else if (event.key === 'ArrowRight') state.colorHsv.s = clamp(state.colorHsv.s + step, 0, 1);
      else if (event.key === 'ArrowUp') state.colorHsv.v = clamp(state.colorHsv.v + step, 0, 1);
      else if (event.key === 'ArrowDown') state.colorHsv.v = clamp(state.colorHsv.v - step, 0, 1);
      else return;
      event.preventDefault(); applyAccent(hsvHex(state.colorHsv)); scheduleSave();
    });
    $('#color-hue').addEventListener('input', (event) => { state.colorHsv.h = Number(event.target.value); applyAccent(hsvHex(state.colorHsv)); scheduleSave(); });
    $('#color-hex').addEventListener('input', (event) => { const value = event.target.value.trim().replace(/^#/, ''); if (/^[0-9a-f]{6}$/i.test(value)) { applyAccent(`#${value}`); scheduleSave(); } });
    $('#color-hex').addEventListener('blur', (event) => { event.target.value = $('#accent-color').value.toUpperCase(); });
    $('#accent-reset').addEventListener('click', () => { applyAccent('#fa5782'); scheduleSave(); });
    document.addEventListener('click', (event) => { if (!event.target.closest('.accent-setting')) setOpen(false); });
  }

  function prepareDynamicUI() {
    $('#demo-button').hidden = desktop;
    ['compression', 'conversion', 'resolution', 'crop', 'frames'].forEach((name, index) => {
      const section = $$('#video-panel > .setting-section')[index]; section.id = `${name}-section`;
      section.addEventListener('toggle', () => {
        if (name === 'crop') {
          if (section.open && state.selectedEffect) { state.selectedEffect = null; updateEffectClips(); }
          elements.cropOverlay.hidden = !section.open || !state.cropVisible || !state.crop; if (section.open && state.crop) requestAnimationFrame(renderCrop);
        }
        if (['crop', 'resolution'].includes(name)) ensurePreciseForTransforms(); updateOutputName();
      });
    });
    $('.audio-output').addEventListener('toggle', updateAudioSummary);
    const metadata = $$('#video-panel .m-switch-row input[type="checkbox"]'); metadata[0].id = 'keep-metadata'; metadata[1].id = 'keep-subtitles';
    const audioSelects = $$('.audio-output select'); audioSelects[0].id = 'audio-codec'; audioSelects[1].id = 'audio-bitrate';
    audioSelects[0].innerHTML = '<option value="aac">AAC / M4A</option><option value="mp3">MP3</option><option value="opus">Opus / OGG</option><option value="flac">FLAC</option><option value="original">Оригинал</option><option value="wav" hidden disabled>WAV</option>';
    audioSelects[1].innerHTML = '<option value="128">128 kb/s</option><option value="192" selected>192 kb/s</option><option value="256">256 kb/s</option><option value="320">320 kb/s</option>';
    elements.exportModal.querySelector('.modal-card').innerHTML = `<button class="m-icon-button modal-close" data-close-modal type="button" aria-label="Закрыть">${icon('close')}</button><span class="modal-icon" id="export-modal-icon">${icon('film')}</span><p class="m-overline" id="export-modal-eyebrow">FFmpeg</p><h2 id="export-modal-title">Экспорт</h2><p id="export-modal-message">Обработка файла…</p><div class="export-progress" id="export-progress"><div><span id="export-progress-value">0%</span></div><div class="export-progress-track"><span id="export-progress-bar"></span></div></div><div class="export-review"><div><span>Файл</span><strong id="review-file"></strong></div><div><span>Формат</span><strong id="review-format"></strong></div><div><span>Фрагмент</span><strong id="review-trim"></strong></div></div><div class="modal-actions"><button class="m-btn m-btn--secondary" id="cancel-export" type="button">Отменить экспорт</button><button class="m-btn m-btn--primary" id="reveal-result" type="button" hidden>Показать в проводнике</button><button class="m-btn m-btn--secondary" id="export-done" data-close-modal type="button" hidden>Закрыть</button></div>`;
    if (desktop) {
      const context = document.createElement('label'); context.className = 'm-switch-row context-setting';
      context.innerHTML = '<span><strong>Открыть через FFConverter</strong><small>Пункт в контекстном меню видеофайлов</small></span><span class="m-switch"><input id="context-menu-setting" type="checkbox"><span></span></span>';
      $('.modal-hint', elements.helpModal).before(context);
      const currentWindow = api.window.getCurrentWindow();
      $$('[data-window-action]').forEach((button) => button.addEventListener('click', async () => {
        try { if (button.dataset.windowAction === 'minimize') await currentWindow.minimize(); if (button.dataset.windowAction === 'maximize') await currentWindow.toggleMaximize(); if (button.dataset.windowAction === 'close') { if (state.activeJob) await invoke('cancel_export', { jobId: state.activeJob }).catch(() => {}); await currentWindow.close(); } }
        catch (error) { toast(String(error), 'error'); }
      }));
    }
    $('#export-kind-select').addEventListener('change', (event) => setExportKind(event.target.value));
    $$('[data-close-modal]').forEach((button) => button.addEventListener('click', closeModals));
    $('#cancel-export').addEventListener('click', async () => { if (!state.activeJob) return; $('#cancel-export').disabled = true; try { await invoke('cancel_export', { jobId: state.activeJob }); } catch (error) { toast(String(error), 'error'); $('#cancel-export').disabled = false; } });
    $('#reveal-result').addEventListener('click', () => invoke('reveal_file', { path: state.exportOutput }).catch((error) => toast(String(error), 'error')));
    $('#audio-codec').addEventListener('change', updateAudioSummary); $('#audio-bitrate').addEventListener('change', updateAudioSummary);
    $('#accent-color').addEventListener('input', (event) => { applyAccent(event.target.value); scheduleSave(); });
    $('#keep-metadata').addEventListener('change', scheduleSave); $('#keep-subtitles').addEventListener('change', scheduleSave);
    $$('[data-add-effect]').forEach((button) => button.addEventListener('click', () => addEffect(button.dataset.addEffect)));
    $('#add-vfx-track').addEventListener('click', () => {
      if (state.vfxTracks < 3) state.vfxTracks += 1;
      else {
        const removedEffects = state.effects.filter((effect) => effect.track === 2);
        const selectedTrack = selectedEffect()?.track;
        state.effects = state.effects.filter((effect) => effect.track !== 2);
        if (selectedTrack === 2) state.selectedEffect = null;
        if (removedEffects.some((effect) => effect.id === state.blurEffectId)) { state.blurEffectId = null; state.blurVisible = false; }
        const removed = removedEffects.length;
        state.vfxTracks = 2;
        if (removed) toast('Третья VFX-дорожка и её клипы удалены.', 'info');
      }
      renderEffects(); updateOutputName();
    });
    $('#blur-range').addEventListener('input', () => updateEffectFromControls('blur'));
    ['brightness', 'contrast', 'saturation'].forEach((name) => $(`#${name}-range`).addEventListener('input', () => updateEffectFromControls('color')));
    $$('#speed-control button').forEach((button) => button.addEventListener('click', () => { const effect = selectedEffect('speed'); if (effect) effect.rate = Number(button.dataset.speed); updateEffectClips(); }));
    $$('#blur-area-mode button').forEach((button) => button.addEventListener('click', () => {
      state.blurVisible = button.dataset.area === 'region';
      elements.video.pause(); stopDemoPlayback(); setPlaying(false); state.cropVisible = false; elements.cropOverlay.hidden = true;
      if (state.blurVisible && !selectedEffect('blur')) addEffect('blur');
      const effect = selectedEffect('blur');
      if (effect) {
        effect.area = state.blurVisible ? { ...state.blurRegion } : null;
        if (state.position < effect.start || state.position >= effect.end) seek(effect.start);
      }
      updateEffectFromControls('blur'); requestAnimationFrame(() => { renderBlurRegion(); updateEffectPreview(); });
    }));
    setupColorPicker();
  }
  async function initializeDesktop() {
    if (!desktop) return;
    try {
      state.settings = await invoke('load_settings'); applyAccent(state.settings.accentColor);
      if (state.settings.codec) elements.codec.value = state.settings.codec; if (state.settings.encoder) elements.encoder.value = state.settings.encoder;
      if (elements.encoder.selectedIndex < 0 || elements.encoder.selectedOptions[0].disabled) elements.encoder.value = 'CPU';
      if (state.settings.quality) elements.quality.value = state.settings.quality; if (state.settings.container) elements.container.value = state.settings.container;
      if (state.settings.audioCodec) $('#audio-codec').value = state.settings.audioCodec;
      if (elements.container.value === 'WebM') { elements.codec.value = 'AV1'; elements.encoder.value = 'CPU'; if (['aac', 'flac', 'mp3', 'original'].includes($('#audio-codec').value)) $('#audio-codec').value = 'opus'; }
      if (state.settings.audioBitrate) $('#audio-bitrate').value = state.settings.audioBitrate; $('#context-menu-setting').checked = Boolean(state.settings.contextMenu);
      $$('#preset-grid button').forEach((button) => { const preset = presets[button.dataset.preset]; button.classList.toggle('is-active', preset && preset.codec === elements.codec.value && preset.encoder === elements.encoder.value && preset.quality === Number(elements.quality.value)); });
      syncAllComboboxes(); updateQuality(); updateCompressionSummary(); updateAudioSummary();
    } catch {}
    state.settingsReady = true; const currentWindow = api.window.getCurrentWindow(); await currentWindow.show(); await currentWindow.setFocus();
    $('#context-menu-setting').addEventListener('change', async (event) => {
      const enabled = event.target.checked;
      try { await invoke('set_context_menu', { enabled }); state.settings.contextMenu = enabled; scheduleSave(); toast(enabled ? 'Пункт добавлен в контекстное меню.' : 'Пункт удалён из контекстного меню.', 'success'); }
      catch (error) { event.target.checked = !enabled; toast(String(error), 'error'); }
    });
    await api.event.listen('export-progress', ({ payload }) => { if (payload.jobId !== state.activeJob) return; const percent = Math.round(payload.percent); $('#export-progress-bar').style.width = `${percent}%`; $('#export-progress-value').textContent = `${percent}% · ${formatTime(payload.time)}`; });
    await api.event.listen('export-finished', ({ payload }) => finishExport(payload));
    await api.event.listen('update-progress', ({ payload }) => { $('#update-progress').hidden = false; $('#update-progress-bar').style.width = `${payload.percent}%`; $('#update-progress-value').textContent = `${payload.percent}%`; $('#update-modal-progress-bar').style.width = `${payload.percent}%`; $('#update-modal-progress-value').textContent = `${payload.percent}%`; $('#update-install').textContent = `Скачивание… ${payload.percent}%`; if (state.update) $('#update-status').textContent = `Скачивание версии ${state.update.latestVersion}…`; });
    const updateError = await invoke('take_update_error'); if (updateError) toast(`Обновление не установлено: ${updateError}`, 'error', { duration: 8000 });
    currentWindow.onDragDropEvent((event) => {
      if (event.payload.type === 'over') elements.dropZone.classList.add('dragover'); if (event.payload.type === 'leave') elements.dropZone.classList.remove('dragover');
      if (event.payload.type === 'drop') { elements.dropZone.classList.remove('dragover'); const path = event.payload.paths[0]; if (path) openMediaPath(path); }
    }).catch(() => {});
    try { const path = await invoke('initial_file'); if (path) openMediaPath(path); } catch {}
    checkForUpdates(false);
    try {
      state.encoderSupport = await invoke('encoder_support'); updateEncoderOptions(); $('#encoder-note').textContent = 'Если аппаратное кодирование недоступно, пресет автоматически использует CPU.';
      if (elements.encoder.selectedOptions[0]?.disabled) { elements.encoder.value = 'CPU'; syncCombobox(elements.encoder); updateQuality(); updateCompressionSummary(); }
    } catch (error) { toast(String(error), 'warning'); }
  }

  elements.fileInput.addEventListener('change', () => { handleFile(elements.fileInput.files[0]); elements.fileInput.value = ''; });
  $('#browse-button').addEventListener('click', (event) => { event.stopPropagation(); openFiles(); }); $('#change-file-button').addEventListener('click', openFiles);
  $('#demo-button').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openWorkspace(); }); $('#home-button').addEventListener('click', showWelcome);
  $('.welcome-header .brand').addEventListener('click', (event) => event.preventDefault()); elements.dropZone.addEventListener('click', (event) => { if (!event.target.closest('button')) openFiles(); });
  if (!desktop) {
    ['dragenter', 'dragover'].forEach((type) => elements.dropZone.addEventListener(type, (event) => { event.preventDefault(); elements.dropZone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((type) => elements.dropZone.addEventListener(type, (event) => { event.preventDefault(); elements.dropZone.classList.remove('dragover'); }));
    elements.dropZone.addEventListener('drop', (event) => handleFile(event.dataTransfer.files[0]));
  }
  elements.video.addEventListener('loadedmetadata', () => {
    if (desktop || state.isDemo || !Number.isFinite(elements.video.duration)) return;
    state.duration = elements.video.duration; state.start = 0; state.end = elements.video.duration; state.originalWidth = elements.video.videoWidth || 1920; state.originalHeight = elements.video.videoHeight || 1080;
    $('#preview-resolution').textContent = `${state.originalWidth} × ${state.originalHeight}`; $('#width-input').value = String(state.originalWidth); $('#height-input').value = String(state.originalHeight); updateOutputName(); updateTimeline();
  });
  elements.video.addEventListener('timeupdate', () => { if (state.isDemo) return; if (elements.video.currentTime >= state.end && state.playing) { elements.video.pause(); setPlaying(false); seek(state.start); return; } seek(elements.video.currentTime, true); syncAudioPlayback(); });
  elements.video.addEventListener('play', () => { setPlaying(true); if (state.audioContext) state.audioContext.resume().catch(() => {}); syncAudioPlayback(); queueBlurPreviewFrame(); });
  elements.video.addEventListener('seeked', () => { syncAudioPlayback(); refreshBlurPreviewFrame(); });
  elements.video.addEventListener('pause', () => { setPlaying(false); stopBlurPreviewUpdates(); state.audioPlayers.forEach((player) => player.audio.pause()); });
  elements.video.addEventListener('ended', () => { setPlaying(false); state.audioPlayers.forEach((player) => player.audio.pause()); seek(state.start); });
  elements.video.addEventListener('error', () => { if (!elements.video.getAttribute('src')) return; setPlaying(false); if (!desktop) toast('Этот формат не поддерживается браузерным предпросмотром.', 'warning'); });
  elements.centerPlay.addEventListener('click', togglePlayback); elements.playButton.addEventListener('click', togglePlayback);
  $('#rewind-button').addEventListener('click', () => seek(state.position - 5)); $('#forward-button').addEventListener('click', () => seek(state.position + 5));
  $('#preview-speed').addEventListener('change', () => { state.previewSpeed = Number($('#preview-speed').value); syncEffectPlaybackRate(); });
  $('#mute-button').addEventListener('click', () => { state.masterMuted = !state.masterMuted; syncPreviewAudio(); });
  $('#fullscreen-button').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('#preview-stage').requestFullscreen(); } catch { toast('Полноэкранный режим недоступен.', 'warning'); } });

  let drag = null;
  function showSnap(value, label) { $('#snap-line').style.left = `${value / state.duration * 100}%`; $('#snap-label').textContent = label; $('#snap-line').hidden = false; }
  function timelineValue(event) { const rect = elements.timeline.getBoundingClientRect(); return clamp((event.clientX - rect.left) / rect.width * state.duration, 0, state.duration); }
  function snapped(value, candidates) {
    $('#snap-line').hidden = true; if (!state.snapping) return value;
    const pixelsPerSecond = elements.timeline.getBoundingClientRect().width / state.duration;
    for (const candidate of candidates) if (Math.abs(value - candidate.value) * pixelsPerSecond <= 12) { showSnap(candidate.value, candidate.label); return candidate.value; }
    return value;
  }
  function moveTimeline(event) {
    if (!drag) return;
    const pixelsPerSecond = elements.timeline.getBoundingClientRect().width / state.duration;
    if (drag.effect) {
      const effect = state.effects.find((item) => item.id === drag.effect); if (!effect) return;
      const effectEdges = state.effects.filter((item) => item.id !== effect.id).flatMap((item) => [
        { value: item.start, label: `Начало: ${effectDefinitions[item.kind].name}` },
        { value: item.end, label: `Конец: ${effectDefinitions[item.kind].name}` }
      ]);
      const candidates = [{ value: 0, label: 'Начало видео' }, { value: state.duration, label: 'Конец видео' }, { value: state.start, label: 'Начало обрезки' }, { value: state.end, label: 'Конец обрезки' }, { value: state.position, label: 'Playhead' }, ...effectEdges];
      if (drag.mode === 'move') {
        const length = drag.end - drag.start;
        let start = clamp(drag.start + (event.clientX - drag.x) / pixelsPerSecond, 0, state.duration - length), end = start + length;
        const rect = elements.timeline.getBoundingClientRect();
        const track = clamp(Math.floor((event.clientY - rect.top - 28) / 32), 0, state.vfxTracks - 1);
        $('#snap-line').hidden = true;
        if (state.snapping) for (const candidate of candidates) {
          if (Math.abs(start - candidate.value) * pixelsPerSecond <= 12) { start = candidate.value; end = start + length; showSnap(start, candidate.label); break; }
          if (Math.abs(end - candidate.value) * pixelsPerSecond <= 12) { end = candidate.value; start = end - length; showSnap(end, candidate.label); break; }
        }
        start = clamp(start, 0, state.duration - length); end = start + length;
        if (!hasOverlap(effect.kind, track, start, end, effect.id)) {
          const changedTrack = effect.track !== track;
          effect.track = track; effect.start = start; effect.end = end;
          if (changedTrack) renderEffects();
        }
      } else {
        const value = snapped(timelineValue(event), candidates), gap = Math.min(.1, state.duration / 10);
        const start = drag.mode === 'start' ? clamp(Math.min(value, effect.end - gap), 0, state.duration) : effect.start;
        const end = drag.mode === 'end' ? clamp(Math.max(value, effect.start + gap), 0, state.duration) : effect.end;
        if (!hasOverlap(effect.kind, effect.track, start, end, effect.id)) { effect.start = start; effect.end = end; }
      }
      updateEffectClips(); return;
    }
    let value = timelineValue(event);
    const candidates = drag.mode === 'playhead' ? [{ value: state.start, label: 'Начало' }, { value: state.end, label: 'Конец' }] : [{ value: state.position, label: 'Playhead' }];
    value = snapped(value, candidates); const gap = Math.min(.1, state.duration / 10);
    if (drag.mode === 'start') state.start = clamp(Math.min(value, state.end - gap), 0, state.duration);
    if (drag.mode === 'end') state.end = clamp(Math.max(value, state.start + gap), 0, state.duration);
    if (drag.mode === 'playhead') scrubTo(value); updateTimeline();
  }
  elements.timeline.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const clip = event.target.closest('.effect-clip[data-effect-id]');
    if (clip) {
      const effect = state.effects.find((item) => item.id === clip.dataset.effectId);
      selectEffect(effect.id);
      drag = { effect: effect.id, mode: event.target.closest('[data-effect-handle]')?.dataset.effectHandle || 'move', x: event.clientX, y: event.clientY, start: effect.start, end: effect.end, track: effect.track, pointerId: event.pointerId };
    } else {
      drag = { mode: event.target.closest('[data-drag]')?.dataset.drag || 'playhead', pointerId: event.pointerId }; state.scrubbing = drag.mode === 'playhead' && !state.isDemo;
      if (drag.mode === 'playhead' && state.selectedEffect) { state.selectedEffect = null; updateEffectClips(); }
      if (state.scrubbing) { state.resumeAfterScrub = state.playing && !elements.video.paused; elements.video.pause(); state.audioPlayers.forEach((player) => player.audio.pause()); }
    }
    elements.timeline.setPointerCapture(event.pointerId); moveTimeline(event); event.preventDefault();
  });
  elements.timeline.addEventListener('pointermove', moveTimeline);
  const finishTimelineDrag = (event) => {
    const activeDrag = drag; if (!activeDrag) return;
    drag = null; $('#snap-line').hidden = true;
    if (state.scrubbing) { const resume = state.resumeAfterScrub; state.scrubbing = false; state.resumeAfterScrub = false; seek(state.position); if (resume) togglePlayback(); }
    const pointerId = event?.pointerId ?? activeDrag.pointerId;
    if (pointerId !== undefined && elements.timeline.hasPointerCapture(pointerId)) elements.timeline.releasePointerCapture(pointerId);
    updateOutputName();
  };
  elements.timeline.addEventListener('pointerup', finishTimelineDrag); elements.timeline.addEventListener('pointercancel', finishTimelineDrag);
  elements.timeline.addEventListener('lostpointercapture', finishTimelineDrag);
  window.addEventListener('pointerup', finishTimelineDrag, true); window.addEventListener('pointercancel', finishTimelineDrag, true);
  window.addEventListener('blur', () => finishTimelineDrag());
  $$('[data-drag]').forEach((handle) => handle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault();
    const step = event.shiftKey ? 1 : .1, direction = event.key === 'ArrowLeft' ? -1 : 1;
    if (handle.dataset.drag === 'start') state.start = event.key === 'Home' ? 0 : event.key === 'End' ? state.end - .1 : clamp(state.start + direction * step, 0, state.end - .1);
    else if (handle.dataset.drag === 'end') state.end = event.key === 'Home' ? state.start + .1 : event.key === 'End' ? state.duration : clamp(state.end + direction * step, state.start + .1, state.duration);
    else seek(event.key === 'Home' ? 0 : event.key === 'End' ? state.duration : state.position + direction * step);
    updateTimeline(); updateOutputName();
  }));
  $('#reset-trim').addEventListener('click', resetTrim);
  $('#snap-toggle').addEventListener('click', () => { state.snapping = !state.snapping; $('#snap-toggle').classList.toggle('is-active', state.snapping); $('#snap-caption').textContent = state.snapping ? 'Притяжение включено' : 'Притяжение выключено'; });
  $('#timeline-zoom').addEventListener('input', (event) => { elements.timeline.style.setProperty('--zoom', Number(event.target.value) / 100); setRangeFill(event.target); });
  $('#audio-labels').addEventListener('scroll', () => { $('#audio-rows').scrollTop = $('#audio-labels').scrollTop; }); $('#audio-rows').addEventListener('scroll', () => { $('#audio-labels').scrollTop = $('#audio-rows').scrollTop; });

  $$('.inspector-tabs button').forEach((tab) => tab.addEventListener('click', () => {
    $$('.inspector-tabs button').forEach((button) => { const active = button === tab; button.classList.toggle('is-active', active); button.setAttribute('aria-selected', String(active)); });
    $$('.inspector-panel').forEach((panel) => { panel.hidden = panel.id !== tab.dataset.panel; }); $('.inspector-scroll').scrollTop = 0;
  }));
  $$('#preset-grid button').forEach((button) => button.addEventListener('click', () => selectPreset(button.dataset.preset)));
  elements.quality.addEventListener('input', () => { updateQuality(); markCustomPreset(); });
  elements.codec.addEventListener('change', () => { updateEncoderOptions(); if (elements.encoder.selectedOptions[0]?.disabled) elements.encoder.value = 'CPU'; syncCombobox(elements.encoder); updateQuality(); markCustomPreset(); });
  elements.encoder.addEventListener('change', () => { updateQuality(); markCustomPreset(); });
  elements.container.addEventListener('change', () => {
    if (elements.container.value === 'WebM') { if (elements.codec.value !== 'AV1') { elements.codec.value = 'AV1'; elements.encoder.value = 'CPU'; syncCombobox(elements.codec); syncCombobox(elements.encoder); updateQuality(); markCustomPreset(); } if (['aac', 'flac', 'mp3', 'original'].includes($('#audio-codec').value)) $('#audio-codec').value = 'opus'; syncCombobox($('#audio-codec')); updateAudioSummary(); toast('Для WebM выбраны совместимые кодеки AV1 и Opus.', 'info'); }
    updateOutputName(); scheduleSave();
  });
  function setTrimMode(mode) {
    $$('#trim-mode button').forEach((button) => { button.classList.toggle('active', button.dataset.mode === mode); button.classList.toggle('is-active', button.dataset.mode === mode); }); updateOutputName();
  }
  $$('#trim-mode button').forEach((button) => button.addEventListener('click', () => {
    setTrimMode(button.dataset.mode);
    if (button.dataset.mode === 'fast') { ensurePreciseForTransforms(); if (button.classList.contains('active')) toast('Без перекодирования. Границы фрагмента зависят от ключевых кадров.', 'info', { duration: 4500 }); }
  }));
  function selectResolution(button) {
    $$('#resolution-presets button').forEach((item) => item.classList.toggle('active', item === button));
    $('#width-input').value = button.textContent === 'Оригинал' ? state.originalWidth : button.dataset.width; $('#height-input').value = button.textContent === 'Оригинал' ? state.originalHeight : button.dataset.height;
    $('#resolution-summary').textContent = `${button.textContent} · ${$('#width-input').value} × ${$('#height-input').value}`; ensurePreciseForTransforms(); updateOutputName();
  }
  $$('#resolution-presets button').forEach((button) => button.addEventListener('click', () => selectResolution(button)));
  function dimensionChanged(changed) {
    const width = $('#width-input'), height = $('#height-input'), value = clamp(Math.round(Number(changed.value) / 2) * 2 || 16, 16, 16384); changed.value = value;
    if ($('#aspect-lock').checked) { const aspect = state.crop ? state.crop.width * state.originalWidth / (state.crop.height * state.originalHeight) : state.originalWidth / state.originalHeight, other = changed === width ? height : width; other.value = Math.max(16, Math.round((changed === width ? value / aspect : value * aspect) / 2) * 2); }
    $$('#resolution-presets button').forEach((button) => button.classList.remove('active')); $('#resolution-summary').textContent = `Пользовательское · ${width.value} × ${height.value}`; ensurePreciseForTransforms(); updateOutputName();
  }
  [$('#width-input'), $('#height-input')].forEach((input) => input.addEventListener('change', () => dimensionChanged(input)));
  $$('#ratio-grid button').forEach((button) => button.addEventListener('click', () => setCropRatio(button.dataset.ratio)));
  $('#crop-preview-button').addEventListener('click', () => { if (!state.crop) { setCropRatio('16:9'); return; } state.cropVisible = !state.cropVisible; elements.cropOverlay.hidden = !state.cropVisible; $('#crop-preview-button').innerHTML = `${icon('crop')}${state.cropVisible ? 'Скрыть' : 'Показать'} область на превью`; });
  setupRegionDrag($('.crop-frame'), () => state.crop, (next) => { state.crop = next; renderCrop(); updateOutputName(); }, 'crop-handle');
  function renderBlurFrame(frame, preview, label, effect) {
    const region = effect.area; if (!region) return;
    const stage = $('#preview-stage').getBoundingClientRect(), rect = videoRect();
    positionFrame(frame, region);
    const scale = Math.min(1, 1280 / stage.width);
    const width = Math.max(1, Math.round(region.width * rect.width * scale)), height = Math.max(1, Math.round(region.height * rect.height * scale));
    preview.style.width = '100%'; preview.style.height = '100%'; preview.style.left = '0px'; preview.style.top = '0px';
    preview.style.filter = `blur(${Math.max(0, effect.intensity * .12)}px)`;
    if (preview.width !== width || preview.height !== height) { preview.width = width; preview.height = height; }
    if (elements.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const sourceWidth = elements.video.videoWidth, sourceHeight = elements.video.videoHeight;
      preview.getContext('2d').drawImage(elements.video, region.x * sourceWidth, region.y * sourceHeight, region.width * sourceWidth, region.height * sourceHeight, 0, 0, width, height);
    }
    if (label) label.textContent = `${Math.round(region.width * state.originalWidth)} × ${Math.round(region.height * state.originalHeight)} · область размытия`;
  }
  function renderBlurRegion(effect = state.effects.find((item) => item.id === state.blurEffectId && item.kind === 'blur')) {
    if (!effect) return;
    renderBlurFrame($('#blur-region > .blur-region-frame'), $('#blur-region-video'), $('#blur-region > .blur-label'), effect);
  }
  function renderBlurPreviews(effects) {
    const root = $('#blur-region'), activeIds = new Set(effects.map((effect) => effect.id));
    $$('.blur-region-preview', root).forEach((preview) => { if (!activeIds.has(preview.dataset.blurId)) preview.remove(); });
    effects.forEach((effect) => {
      let container = $$('.blur-region-preview', root).find((preview) => preview.dataset.blurId === effect.id);
      if (!container) {
        container = document.createElement('div'); container.className = 'blur-region-preview'; container.dataset.blurId = effect.id;
        container.innerHTML = '<div class="blur-region-frame"><canvas class="blur-region-video" aria-hidden="true"></canvas></div>';
        root.append(container);
      }
      renderBlurFrame($('.blur-region-frame', container), $('.blur-region-video', container), null, effect);
    });
  }
  function renderActiveBlurRegions() {
    const blurs = state.effects.filter((effect) => effect.kind === 'blur' && effect.area && state.position >= effect.start && state.position < effect.end);
    const primary = blurs.find((effect) => effect.id === state.blurEffectId) || blurs[0];
    if (primary) renderBlurRegion(primary);
    renderBlurPreviews(blurs.filter((effect) => effect.id !== primary?.id));
  }
  function stopBlurPreviewUpdates() {
    if (state.blurVideoFrame !== null && elements.video.cancelVideoFrameCallback) elements.video.cancelVideoFrameCallback(state.blurVideoFrame);
    if (state.blurAnimation) cancelAnimationFrame(state.blurAnimation);
    state.blurVideoFrame = null; state.blurAnimation = null;
  }
  function queueBlurPreviewFrame() {
    if ($('#blur-region').hidden || !state.playing || state.blurVideoFrame !== null || state.blurAnimation) return;
    if (elements.video.requestVideoFrameCallback) {
      state.blurVideoFrame = elements.video.requestVideoFrameCallback(() => {
        state.blurVideoFrame = null;
        if ($('#blur-region').hidden || !state.playing) return;
        renderActiveBlurRegions(); queueBlurPreviewFrame();
      });
    } else {
      state.blurAnimation = requestAnimationFrame(tickBlurPreview);
    }
  }
  function refreshBlurPreviewFrame() {
    if (elements.video.requestVideoFrameCallback) elements.video.requestVideoFrameCallback(() => renderActiveBlurRegions());
    else requestAnimationFrame(() => renderActiveBlurRegions());
  }
  function tickBlurPreview() {
    state.blurAnimation = null;
    if ($('#blur-region').hidden || !state.playing) return;
    renderActiveBlurRegions(); queueBlurPreviewFrame();
  }
  setupRegionDrag($('#blur-region > .blur-region-frame'), () => state.blurRegion, (next) => { state.blurRegion = next; const effect = selectedEffect('blur'); if (effect) effect.area = { ...next }; renderBlurRegion(); }, 'blur-handle');
  window.addEventListener('resize', () => { if (state.crop) renderCrop(); renderActiveBlurRegions(); });
  $$('#image-format button').forEach((button) => button.addEventListener('click', () => setExportKind(button.dataset.format.toLowerCase())));
  $('#single-frame').addEventListener('change', () => { setExportKind(state.exportKind); });
  $('#fps-range').addEventListener('input', () => { setRangeFill($('#fps-range')); if (!$('#fps-range').disabled) $('#fps-value').textContent = `${$('#fps-range').value} FPS`; updateOutputName(); });
  $('#reset-settings').addEventListener('click', resetSettings); $('#help-button').addEventListener('click', () => openModal(elements.helpModal)); $('#welcome-help-button').addEventListener('click', () => openModal(elements.helpModal));
  $('#export-button').addEventListener('click', startExport); $('#loading-change-file').addEventListener('click', openFiles); $('#loading-home').addEventListener('click', showWelcome);
  $('#update-check').addEventListener('click', () => { if (state.update?.available) { state.updatePromptShown = false; showUpdateAvailable(); } else checkForUpdates(true); });
  $('#update-install').addEventListener('click', async () => { if (state.activeJob) { toast('Дождитесь завершения экспорта.', 'warning'); return; } if (state.update?.downloaded) await installDownloadedUpdate(); else await downloadUpdate(true); });
  $$('.app-modal').forEach((modal) => modal.addEventListener('click', (event) => { if (event.target === modal) closeModals(); }));
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') { event.preventDefault(); return; }
    if (event.key === 'Escape') { closeModals(); if (state.crop) { state.cropVisible = false; elements.cropOverlay.hidden = true; } return; }
    if (elements.workspace.hidden || !elements.exportModal.hidden || !elements.helpModal.hidden || !elements.updateModal.hidden) return;
    const editingText = event.target.matches('input:not([type="range"]):not([type="checkbox"]), select, textarea, [contenteditable="true"]');
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') {
      if (editingText) return;
      event.preventDefault(); if (!event.repeat) undoRemoveEffect(); return;
    }
    if (event.key === 'Delete' && state.selectedEffect) {
      if (editingText) return;
      event.preventDefault(); if (!event.repeat) removeEffect(state.selectedEffect); return;
    }
    if (event.code === 'Space') {
      if (event.target.matches('input:not([type="range"]):not([type="checkbox"]), textarea')) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) togglePlayback();
      return;
    }
    if (event.target.matches('input, select, textarea, button, summary')) return;
    if (event.key === 'ArrowLeft') seek(state.position - 5); if (event.key === 'ArrowRight') seek(state.position + 5); if (event.key.toLowerCase() === 'r') resetTrim();
  });

  prepareDynamicUI(); replaceNativeSelects(); $$('input[type="range"]').forEach(setRangeFill);
  clearThumbnails(); setExportKind('video'); updateQuality(); updateEffectFromControls('blur'); updateEffectFromControls('color');
  renderEffects(); updateTimeline(); updateAudioSummary(); Mono.init(); createCustomScrollbar($('.inspector-scroll'), 'inspector-wrap');
  initializeDesktop().catch((error) => {
    console.error('Ошибка инициализации FFConverter:', error);
    toast(`Не удалось инициализировать приложение: ${String(error)}`, 'error', { duration: 8000 });
  });
})();
