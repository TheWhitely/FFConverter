(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const icon = (name) => `<svg class="icon"><use href="#i-${name}"></use></svg>`;
  const desktop = Boolean(window.__TAURI__?.core);
  const api = desktop ? window.__TAURI__ : null;
  const invoke = (command, args = {}) => api.core.invoke(command, args);

  const elements = {
    welcome: $('#welcome-screen'),
    workspace: $('#workspace'),
    fileInput: $('#file-input'),
    dropZone: $('#drop-zone'),
    video: $('#video-preview'),
    poster: $('#demo-poster'),
    timeline: $('#timeline-track'),
    centerPlay: $('#center-play'),
    playButton: $('#play-button'),
    quality: $('#quality-range'),
    codec: $('#codec-select'),
    encoder: $('#encoder-select'),
    container: $('#container-select'),
    cropOverlay: $('#crop-overlay'),
    exportModal: $('#export-modal'),
    helpModal: $('#help-modal'),
    updateModal: $('#update-modal')
  };

  const state = {
    duration: 41,
    position: 0,
    start: 0,
    end: 41,
    isDemo: true,
    playing: false,
    demoFrame: null,
    lastDemoTick: 0,
    cropRatio: 'free',
    crop: null,
    cropVisible: false,
    objectUrl: null,
    media: null,
    originalWidth: 1920,
    originalHeight: 1080,
    audio: [],
    audioPlayers: [],
    audioContext: null,
    masterMuted: false,
    exportKind: 'video',
    activeJob: null,
    exportOutput: '',
    loadToken: 0,
    settings: {},
    settingsReady: false,
    encoderSupport: null,
    saveTimer: null,
    update: null,
    updateBusy: false,
    updatePromptShown: false,
    scrubbing: false,
    resumeAfterScrub: false
  };

  const presets = {
    quality: { codec: 'AV1', encoder: 'NVIDIA NVENC', quality: 32, label: 'Качество' },
    balance: { codec: 'HEVC', encoder: 'NVIDIA NVENC', quality: 21, label: 'Баланс' }
  };

  const videoFilters = [{ name: 'Видео', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'ts', 'm2ts'] }];
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

  function toast(message, type = 'info', options) {
    if (window.Whitely?.toast) Whitely.toast(message, type, options);
  }

  function formatTime(seconds, milliseconds = false) {
    const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const wholeSeconds = Math.floor(safe % 60);
    const base = hours > 0
      ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}`;
    return milliseconds ? `${base}.${String(Math.floor((safe % 1) * 1000)).padStart(3, '0')}` : base;
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Локальный файл';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(unit >= 2 && value < 100 ? 1 : 0).replace('.', ',')} ${units[unit]}`;
  }

  function setRangeFill(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    input.style.setProperty('--val', `${((Number(input.value) - min) / (max - min)) * 100}%`);
  }

  function applyAccent(value) {
    const color = /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : '#fa5782';
    const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
    const mix = (target, amount) => rgb.map((channel, index) => Math.round(channel + (target[index] - channel) * amount));
    const hex = (channels) => `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
    const root = document.documentElement.style;
    root.setProperty('--accent', color);
    root.setProperty('--accent-rgb', rgb.join(','));
    root.setProperty('--accent-2', hex(mix([255, 255, 255], .22)));
    root.setProperty('--accent-deep', hex(mix([0, 0, 0], .18)));
    root.setProperty('--accent-soft', `rgba(${rgb.join(',')},.12)`);
    root.setProperty('--accent-glow', `rgba(${rgb.join(',')},.35)`);
    $('#accent-color').value = color;
    $('#accent-value').textContent = color.toUpperCase();
  }

  function baseFileName(name) {
    return name.replace(/\.[^.]+$/, '');
  }

  function sectionOpen(id) {
    return Boolean($(`#${id}-section`)?.open);
  }

  function originalExtension() {
    const name = state.media?.name || 'Showreel_2026.mp4';
    return name.match(/\.([^.]+)$/)?.[1].toLowerCase() || 'mp4';
  }

  function automaticCodec(extension) {
    if (extension === 'webm') return 'AV1';
    const source = state.media?.codec?.toLowerCase();
    if (source === 'h264') return 'H.264';
    if (source === 'hevc' || source === 'h265') return 'HEVC';
    if (source === 'av1') return 'AV1';
    return 'H.264';
  }

  function canCopyVideo(extension) {
    if (extension === originalExtension()) return true;
    const source = state.media?.codec?.toLowerCase();
    if (['mkv', 'avi', 'ts', 'm2ts'].includes(extension)) return true;
    if (['mp4', 'mov', 'm4v'].includes(extension)) return ['h264', 'hevc', 'h265', 'av1', 'mpeg4'].includes(source);
    if (extension === 'webm') return ['vp8', 'vp9', 'av1'].includes(source);
    return false;
  }

  function videoOptions() {
    const conversion = sectionOpen('conversion');
    const compression = sectionOpen('compression');
    const resolution = sectionOpen('resolution');
    const crop = sectionOpen('crop') ? state.crop : null;
    const extension = conversion && elements.container.value !== 'original' ? elements.container.value.toLowerCase() : originalExtension();
    const even = (value) => Math.max(16, Math.round(value / 2) * 2);
    const width = resolution ? even(Number($('#width-input').value) || state.originalWidth) : crop ? even(crop.width * state.originalWidth) : state.originalWidth;
    const height = resolution ? even(Number($('#height-input').value) || state.originalHeight) : crop ? even(crop.height * state.originalHeight) : state.originalHeight;
    const transformed = Boolean(crop) || width !== state.originalWidth || height !== state.originalHeight;
    const fast = $('#trim-mode button.active').dataset.mode === 'fast';
    const codec = compression ? elements.codec.value : automaticCodec(extension);
    const encoder = compression ? elements.encoder.value : 'CPU';
    const copyVideo = state.exportKind === 'video' && !transformed && canCopyVideo(extension) && (fast || !compression);
    return {
      conversion, compression, resolution, crop, extension, width, height, transformed, fast, codec, encoder, copyVideo,
      quality: compression ? Number(elements.quality.value) : 23,
      audioCodec: state.exportKind === 'audio' ? $('#audio-codec').value : extension === 'webm' ? 'opus' : $('.audio-output').open ? $('#audio-codec').value : 'original',
      keepMetadata: conversion ? $('#keep-metadata').checked : true,
      keepSubtitles: conversion ? $('#keep-subtitles').checked : true
    };
  }

  function ensurePreciseForTransforms() {
    const options = videoOptions();
    if (!options.fast || !options.transformed) return;
    $$('#trim-mode button').forEach((button) => button.classList.toggle('active', button.dataset.mode === 'precise'));
    toast('Для кадрирования или изменения разрешения нужен точный режим с перекодированием.', 'info', { duration: 4500 });
  }

  function selectedAudioTracks() {
    return state.audio.filter((track) => track.enabled);
  }

  function audioExtension() {
    return ({ aac: 'm4a', mp3: 'mp3', flac: 'flac', wav: 'wav', opus: 'ogg' })[$('#audio-codec').value] || 'mp3';
  }

  function currentExtension() {
    if (state.exportKind === 'video') return videoOptions().extension;
    return state.exportKind === 'audio' ? audioExtension() : state.exportKind;
  }

  function outputName() {
    const name = state.media?.name || 'Showreel_2026.mp4';
    const extension = currentExtension();
    if (state.exportKind === 'video') return `${baseFileName(name)}_${videoOptions().copyVideo ? 'cut' : 'converted'}.${extension}`;
    if (state.exportKind === 'gif') return `${baseFileName(name)}.gif`;
    if (state.exportKind === 'audio') return `${baseFileName(name)}_audio.${extension}`;
    return `${baseFileName(name)}_${String(Math.round(state.position * 1000)).padStart(7, '0')}.${extension}`;
  }

  function updateOutputName() {
    const options = videoOptions();
    const extension = currentExtension();
    $('#container-select option[value="original"]').textContent = `Оригинал (${originalExtension().toUpperCase()})`;
    const sequence = ['png', 'jpg'].includes(state.exportKind) && !$('#single-frame').checked;
    $('#output-file-name').textContent = sequence ? `frame_00001.${extension} …` : outputName();
    $('#output-format').textContent = extension.toUpperCase();
    const resolution = `${options.width} × ${options.height}`;
    const videoLabel = options.copyVideo ? 'Без перекодирования' : options.compression ? options.codec : `Авто · ${options.codec}`;
    $('#export-summary').textContent = state.exportKind === 'video'
      ? `${extension.toUpperCase()} · ${videoLabel} · ${resolution}`
      : state.exportKind === 'audio'
        ? `${extension.toUpperCase()} · ${selectedAudioTracks().length} дор. · ${formatTime(state.start)} — ${formatTime(state.end)}`
        : `${state.exportKind.toUpperCase()} · ${resolution}${state.exportKind === 'gif' ? ` · ${$('#fps-range').value} FPS` : ''}`;
    const activePreset = $('#preset-grid button.active')?.dataset.preset;
    $('#compression-summary').textContent = !options.compression ? 'Не применяется' : options.copyVideo ? 'Без перекодирования' : `${presets[activePreset]?.label || 'Пользовательский'} · ${elements.codec.value}`;
    $('#conversion-section summary small').textContent = options.conversion && elements.container.value !== 'original' ? `${extension.toUpperCase()} · контейнер` : `Оригинал · ${originalExtension().toUpperCase()}`;
    const activeResolution = $('#resolution-presets button.active')?.textContent || 'Пользовательское';
    $('#resolution-summary').textContent = options.resolution ? `${activeResolution} · ${options.width} × ${options.height}` : 'Не применяется';
    $('#crop-summary').textContent = !sectionOpen('crop') ? 'Не применяется' : state.crop ? `${Math.round(state.crop.width * state.originalWidth) & ~1} × ${Math.round(state.crop.height * state.originalHeight) & ~1} · ${state.cropRatio}` : 'Весь кадр';
    $('#export-button > span').textContent = state.activeJob ? 'Экспорт…' : state.exportKind === 'video' ? 'Экспортировать' : state.exportKind === 'audio' ? 'Извлечь аудио' : `Сохранить ${extension.toUpperCase()}`;
    if (state.position >= 0) $('#frame-time-label').textContent = `Позиция ${formatTime(state.position, true)}`;
  }

  function updateTimeline() {
    const duration = Math.max(state.duration, 0.001);
    elements.timeline.style.setProperty('--start', `${(state.start / duration) * 100}%`);
    elements.timeline.style.setProperty('--end', `${(state.end / duration) * 100}%`);
    elements.timeline.style.setProperty('--position', `${(state.position / duration) * 100}%`);
    $('#playback-current').textContent = formatTime(state.position);
    $('#playback-duration').textContent = formatTime(state.duration);
    $('#trim-start-time').innerHTML = `Начало&nbsp; ${formatTime(state.start, true)}`;
    $('#trim-end-time').innerHTML = `Конец&nbsp; ${formatTime(state.end, true)}`;
    $('#trim-length').textContent = `${(state.end - state.start).toFixed(1).replace('.', ',')} сек`;
    $('#frame-time-label').textContent = `Позиция ${formatTime(state.position, true)}`;
    [0, .25, .5, .75, 1].forEach((part, index) => {
      $$('.timeline-ruler span')[index].textContent = formatTime(state.duration * part);
    });
    [[$('.trim-start'), state.start], [$('.trim-end'), state.end], [$('.playhead'), state.position]].forEach(([slider, value]) => {
      slider.setAttribute('aria-valuemax', state.duration.toFixed(2));
      slider.setAttribute('aria-valuenow', value.toFixed(2));
      slider.setAttribute('aria-valuetext', formatTime(value, true));
    });
  }

  function seek(value, fromVideo = false) {
    state.position = clamp(value, 0, state.duration);
    if (!fromVideo && !state.isDemo && Number.isFinite(elements.video.duration)) {
      state.audioPlayers.forEach((player) => player.audio.pause());
      elements.video.currentTime = state.position;
    }
    updateTimeline();
    if (state.exportKind !== 'video' && $('#single-frame').checked) updateOutputName();
  }

  function scrubTo(value) {
    state.position = clamp(value, 0, state.duration);
    updateTimeline();
  }

  function setPlaying(playing) {
    state.playing = playing;
    elements.centerPlay.classList.toggle('playing', playing);
    elements.playButton.classList.toggle('is-playing', playing);
    elements.centerPlay.classList.toggle('is-playing', playing);
    elements.centerPlay.innerHTML = icon(playing ? 'pause' : 'play');
    elements.playButton.innerHTML = icon(playing ? 'pause' : 'play');
    elements.centerPlay.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
    elements.playButton.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
  }

  function stopDemoPlayback() {
    if (state.demoFrame) cancelAnimationFrame(state.demoFrame);
    state.demoFrame = null;
    state.lastDemoTick = 0;
  }

  function tickDemo(timestamp) {
    if (!state.playing || !state.isDemo) return;
    if (!state.lastDemoTick) state.lastDemoTick = timestamp;
    const elapsed = (timestamp - state.lastDemoTick) / 1000;
    state.lastDemoTick = timestamp;
    if (state.position + elapsed >= state.end) {
      seek(state.start);
      setPlaying(false);
      return;
    }
    seek(state.position + elapsed);
    state.demoFrame = requestAnimationFrame(tickDemo);
  }

  async function togglePlayback() {
    if (state.playing) {
      if (state.isDemo) stopDemoPlayback();
      else elements.video.pause();
      setPlaying(false);
      return;
    }
    if (!state.isDemo && !elements.video.src) return;
    if (state.position >= state.end || state.position < state.start) seek(state.start);
    setPlaying(true);
    if (state.isDemo) {
      state.demoFrame = requestAnimationFrame(tickDemo);
    } else {
      try {
        if (state.audioContext) await state.audioContext.resume();
        await elements.video.play();
        syncAudioPlayback();
      } catch {
        state.audioPlayers.forEach((player) => player.audio.pause());
        setPlaying(false);
        toast('Не удалось запустить предпросмотр.', 'warning');
      }
    }
  }

  function syncPreviewAudio() {
    const audible = state.audio.length ? state.audio.some((track) => track.enabled && track.volume > 0) : true;
    if (state.audioPlayers.length) {
      elements.video.muted = true;
      state.audioPlayers.forEach((player) => {
        const track = state.audio.find((item) => item.index === player.index);
        const volume = !state.masterMuted && track?.enabled ? track.volume : 0;
        if (player.gain) player.gain.gain.value = volume;
        else player.audio.volume = clamp(volume, 0, 1);
        player.audio.muted = volume === 0;
      });
    } else {
      const first = state.audio[0];
      elements.video.volume = first?.enabled ? clamp(first.volume, 0, 1) : 1;
      elements.video.muted = state.masterMuted || Boolean(first && (!first.enabled || first.volume === 0));
    }
    $('#mute-button').innerHTML = icon(state.masterMuted || !audible ? 'muted' : 'volume');
  }

  function syncAudioPlayback() {
    state.audioPlayers.forEach((player) => {
      const audio = player.audio;
      if (state.scrubbing || elements.video.seeking) { audio.pause(); return; }
      if (Number.isFinite(audio.duration) && Math.abs(audio.currentTime - elements.video.currentTime) > .12) {
        audio.currentTime = elements.video.currentTime;
      }
      if (state.playing && !elements.video.paused) audio.play().catch(() => {});
      else audio.pause();
    });
  }

  function clearAudioPlayers() {
    state.audioPlayers.forEach((player) => {
      player.audio.pause();
      player.audio.removeAttribute('src');
      player.audio.load();
      player.source?.disconnect();
      player.gain?.disconnect();
    });
    state.audioPlayers = [];
    elements.video.muted = state.masterMuted;
  }

  function waitForMedia(media, token) {
    if (token !== state.loadToken) return Promise.resolve(false);
    if (media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        media.removeEventListener('canplay', ready);
        media.removeEventListener('error', failed);
      };
      const ready = () => { cleanup(); resolve(true); };
      const failed = () => { cleanup(); reject(new Error('Браузер не смог загрузить подготовленное превью.')); };
      media.addEventListener('canplay', ready, { once: true });
      media.addEventListener('error', failed, { once: true });
    });
  }

  async function prepareAudioPlayers(previews, token) {
    clearAudioPlayers();
    if (!previews.length) { syncPreviewAudio(); return token === state.loadToken; }
    const Context = window.AudioContext || window.webkitAudioContext;
    if (Context && !state.audioContext) state.audioContext = new Context();
    previews.forEach((preview) => {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.crossOrigin = 'anonymous';
      audio.src = preview.url;
      let source = null;
      let gain = null;
      if (state.audioContext) {
        source = state.audioContext.createMediaElementSource(audio);
        gain = state.audioContext.createGain();
        source.connect(gain);
        gain.connect(state.audioContext.destination);
      }
      state.audioPlayers.push({ index: preview.index, audio, source, gain });
    });
    syncPreviewAudio();
    syncAudioPlayback();
    const readiness = await Promise.all(state.audioPlayers.map((player) => waitForMedia(player.audio, token)));
    return token === state.loadToken && readiness.every(Boolean);
  }

  function resetPlayback() {
    stopDemoPlayback();
    state.scrubbing = false;
    state.resumeAfterScrub = false;
    elements.video.pause();
    clearAudioPlayers();
    setPlaying(false);
    state.position = 0;
  }

  function clearThumbnails() {
    $$('.timeline-thumbnails span').forEach((span, index) => {
      span.style.backgroundImage = '';
      span.style.backgroundSize = '';
      span.style.backgroundPosition = '';
      span.style.filter = '';
      span.dataset.index = index;
    });
  }

  function populateMedia(info) {
    state.media = info;
    state.isDemo = false;
    state.duration = Math.max(info.duration, .001);
    state.start = 0;
    state.end = state.duration;
    state.position = 0;
    state.originalWidth = info.width;
    state.originalHeight = info.height;
    state.audio = info.audio.map((track) => ({ ...track, enabled: true, volume: 1 }));
    $('#header-file-name').textContent = info.name;
    $('#header-file-meta').textContent = `${info.name.split('.').pop().toUpperCase()} · ${formatFileSize(info.size)}`;
    $('#preview-file-label').textContent = info.name;
    $('#workspace-mode').textContent = 'Подготовка превью…';
    $('#preview-resolution').textContent = `${info.width} × ${info.height}`;
    $('#preview-codec').textContent = `${info.codec.toUpperCase()} · ${info.fps ? info.fps.toFixed(info.fps % 1 ? 2 : 0) : '—'} FPS`;
    elements.poster.hidden = true;
    elements.video.hidden = false;
    $('#width-input').value = String(info.width);
    $('#height-input').value = String(info.height);
    $('#resolution-summary').textContent = `Как в оригинале · ${info.width} × ${info.height}`;
    $$('#resolution-presets button').forEach((button) => button.classList.toggle('active', button.textContent === 'Оригинал'));
    setCropRatio('free');
    renderAudioTracks();
    clearThumbnails();
    elements.welcome.hidden = true;
    elements.workspace.hidden = false;
    updateOutputName();
    updateTimeline();
  }

  function openWorkspace(file = null) {
    resetPlayback();
    state.loadToken += 1;
    $('#workbench-loading').hidden = true;
    $('.workbench').setAttribute('aria-busy', 'false');
    state.media = null;
    state.isDemo = !file;
    state.duration = 41;
    state.start = 0;
    state.end = 41;
    state.position = 0;
    state.originalWidth = 1920;
    state.originalHeight = 1080;
    const demoAudio = [
      { index: 1, number: 1, name: 'Основная дорожка', language: 'Русский', codec: 'AAC', channels: 2, sampleRate: 48000, bitRate: 192000 },
      { index: 2, number: 2, name: 'Комментарии', language: 'English', codec: 'AAC', channels: 2, sampleRate: 48000, bitRate: 160000 }
    ];
    if (!file) {
      state.media = { name: 'Showreel_2026.mp4', size: 50500000, audio: demoAudio };
      state.audio = demoAudio.map((track) => ({ ...track, enabled: true, volume: 1 }));
    } else {
      state.audio = [];
    }
    const name = file ? file.name : 'Showreel_2026.mp4';
    $('#header-file-name').textContent = name;
    $('#header-file-meta').textContent = file ? `${name.split('.').pop().toUpperCase()} · ${formatFileSize(file.size)}` : 'MP4 · 48,2 МБ';
    $('#preview-file-label').textContent = name;
    $('#workspace-mode').textContent = file ? 'Браузерный предпросмотр' : 'Демо-режим';
    $('#preview-resolution').textContent = '1920 × 1080';
    $('#preview-codec').textContent = file ? 'ЛОКАЛЬНЫЙ ФАЙЛ' : 'H.264 · 30 FPS';
    elements.poster.hidden = Boolean(file);
    elements.video.hidden = !file;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
    elements.video.removeAttribute('src');
    elements.video.load();
    if (file) {
      state.objectUrl = URL.createObjectURL(file);
      elements.video.src = state.objectUrl;
      elements.video.load();
    }
    $('#width-input').value = '1920';
    $('#height-input').value = '1080';
    $('#resolution-summary').textContent = 'Как в оригинале · 1920 × 1080';
    setCropRatio('free');
    renderAudioTracks();
    clearThumbnails();
    elements.welcome.hidden = true;
    elements.workspace.hidden = false;
    updateOutputName();
    updateTimeline();
  }

  function showWorkbenchLoading(status) {
    $('#loading-title').textContent = 'Подготовка видео';
    $('#loading-status').textContent = status;
    $('#loading-actions').hidden = true;
    $('#workbench-loading').classList.remove('is-error');
    $('#workbench-loading').hidden = false;
    $('.workbench').setAttribute('aria-busy', 'true');
    $('#workspace-mode').textContent = 'Подготовка видео…';
  }

  function showLoadingError(message) {
    $('#loading-title').textContent = 'Не удалось открыть видео';
    $('#loading-status').textContent = message;
    $('#loading-actions').hidden = false;
    $('#workbench-loading').classList.add('is-error');
    $('#workbench-loading').hidden = false;
    $('.workbench').setAttribute('aria-busy', 'false');
    $('#workspace-mode').textContent = 'Ошибка открытия';
  }

  async function loadThumbnails(urls, token) {
    await Promise.all(urls.map((url) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = resolve;
      image.onerror = () => reject(new Error('Не удалось загрузить кадры таймлайна.'));
      image.src = url;
    })));
    if (token !== state.loadToken) return false;
    $$('.timeline-thumbnails span').forEach((span, index) => {
      if (!urls[index]) return;
      span.style.backgroundImage = `linear-gradient(180deg, transparent 55%, rgba(5,6,9,.55)), url("${urls[index]}")`;
      span.style.backgroundSize = '100% 100%';
      span.style.backgroundPosition = '0 0';
    });
    return true;
  }

  async function openMediaPath(path) {
    const token = ++state.loadToken;
    resetPlayback();
    $('#workspace-mode').textContent = 'Открытие файла…';
    try {
      const info = await invoke('open_media', { path });
      if (token !== state.loadToken) return;
      populateMedia(info);
      showWorkbenchLoading('Загрузка превью…');
      elements.video.removeAttribute('src');
      elements.video.load();

      const preview = await invoke('prepare_preview', { path });
      if (token !== state.loadToken) return;
      elements.video.src = preview.url;
      elements.video.load();
      if (!await waitForMedia(elements.video, token) || token !== state.loadToken) return;

      showWorkbenchLoading('Создание кадров таймлайна…');
      const urls = await invoke('generate_thumbnails', { path });
      if (token !== state.loadToken) return;
      if (!await loadThumbnails(urls, token) || token !== state.loadToken) return;

      showWorkbenchLoading(info.audio.length ? 'Подготовка звуковых дорожек…' : 'Завершение подготовки…');
      const previews = info.audio.length ? await invoke('prepare_audio_previews', { path }) : [];
      if (token !== state.loadToken) return;
      if (!await prepareAudioPlayers(previews, token) || token !== state.loadToken) return;

      $('#workbench-loading').hidden = true;
      $('.workbench').setAttribute('aria-busy', 'false');
      $('#workspace-mode').textContent = preview.proxied ? 'Превью H.264 · экспорт из оригинала' : 'Файл открыт';
    } catch (error) {
      if (token !== state.loadToken) return;
      const message = String(error);
      toast(message, 'error', { duration: 7000 });
      if (elements.workspace.hidden) showWelcome();
      else showLoadingError(message);
    }
  }

  function showWelcome() {
    state.loadToken += 1;
    resetPlayback();
    $('#workbench-loading').hidden = true;
    $('.workbench').setAttribute('aria-busy', 'false');
    elements.workspace.hidden = true;
    elements.welcome.hidden = false;
  }

  async function openFiles() {
    if (desktop) {
      try {
        const path = await api.dialog.open({ multiple: false, directory: false, filters: videoFilters });
        if (path) openMediaPath(path);
      } catch (error) { toast(String(error), 'error'); }
    } else {
      elements.fileInput.click();
    }
  }

  function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith('video/') && !/\.(mp4|mkv|mov|avi|webm|m4v|wmv|flv|ts|m2ts)$/i.test(file.name)) {
      toast('Выберите видеофайл.', 'error');
      return;
    }
    openWorkspace(file);
  }

  function updatePresetLabels() {
    $$('#preset-grid button').forEach((button) => {
      const preset = presets[button.dataset.preset];
      if (!preset) return;
      const supported = !state.encoderSupport || (preset.codec === 'AV1' ? state.encoderSupport.nvidiaAv1 : state.encoderSupport.nvidia);
      const encoder = supported ? preset.encoder : 'CPU';
      $('small', button).textContent = `${preset.codec} · ${encoder} · ${encoder === 'CPU' ? 'CRF' : 'CQ'} ${preset.quality}`;
    });
  }

  function updateEncoderOptions() {
    if (!state.encoderSupport) return;
    const nvidia = Array.from(elements.encoder.options).find((option) => option.value === 'NVIDIA NVENC');
    const intel = Array.from(elements.encoder.options).find((option) => option.value === 'Intel Quick Sync');
    if (nvidia) nvidia.disabled = !state.encoderSupport.nvidia || (elements.codec.value === 'AV1' && !state.encoderSupport.nvidiaAv1);
    if (intel) intel.disabled = !state.encoderSupport.intel;
    updatePresetLabels();
  }

  function updateQuality() {
    const value = Number(elements.quality.value);
    const label = value <= 20 ? 'Очень высокое' : value <= 25 ? 'Высокое' : value <= 30 ? 'Среднее' : 'Компактное';
    $('#quality-value').textContent = `${elements.encoder.value === 'CPU' ? 'CRF' : 'CQ'} ${value} · ${label}`;
    setRangeFill(elements.quality);
  }

  function updateCompressionSummary(presetName = null) {
    const active = presetName || $('#preset-grid button.active')?.dataset.preset;
    $('#compression-summary').textContent = `${presets[active]?.label || 'Пользовательский'} · ${elements.codec.value}`;
    updateOutputName();
    scheduleSave();
  }

  function selectPreset(name, persist = true) {
    const preset = presets[name];
    if (!preset) return;
    $$('#preset-grid button').forEach((button) => button.classList.toggle('active', button.dataset.preset === name));
    elements.codec.value = preset.codec;
    updateEncoderOptions();
    elements.encoder.value = preset.encoder;
    if (elements.encoder.selectedOptions[0]?.disabled) {
      elements.encoder.value = 'CPU';
      toast('Аппаратный кодировщик недоступен, выбран CPU.', 'warning');
    }
    elements.quality.value = preset.quality;
    updateQuality();
    if (persist) updateCompressionSummary(name);
  }

  function markCustomPreset() {
    $$('#preset-grid button').forEach((button) => button.classList.remove('active'));
    updateCompressionSummary();
  }

  function renderUpdate(info) {
    state.update = info;
    const status = info.downloading ? `Скачивание версии ${info.latestVersion}…`
      : info.downloaded ? `Версия ${info.latestVersion} готова к установке`
      : info.available ? `Доступна версия ${info.latestVersion}`
      : `Установлена последняя версия · ${info.currentVersion}`;
    $('#update-status').textContent = status;
    $('#update-check').textContent = info.downloaded ? 'Установить' : info.available ? 'Обновить' : 'Проверить';
    $('#update-check').disabled = info.downloading;
    $('#update-progress').hidden = !info.downloading;
    if (!info.downloading) {
      $('#update-progress-bar').style.width = '0%';
      $('#update-progress-value').textContent = '0%';
    }
  }

  function showUpdateAvailable() {
    const info = state.update;
    if (!info?.available || state.updatePromptShown) return;
    state.updatePromptShown = true;
    $('#update-modal-eyebrow').textContent = info.downloaded ? 'Обновление готово' : 'Доступно обновление';
    $('#update-version-label').textContent = `Версия ${info.currentVersion} → ${info.latestVersion}`;
    $('#update-notes').textContent = info.notes.trim() || 'Настройки и файлы кэша будут сохранены.';
    $('#update-install').disabled = Boolean(state.activeJob);
    $('#update-install').textContent = state.activeJob ? 'Дождитесь завершения экспорта' : info.downloaded ? 'Обновить и перезапустить' : 'Скачать и установить';
    $('#update-modal-progress').hidden = true;
    openModal(elements.updateModal);
  }

  async function installDownloadedUpdate() {
    if (!state.update?.downloaded) return;
    if (state.activeJob) { toast('Дождитесь завершения экспорта.', 'warning'); return; }
    $('#update-install').disabled = true;
    try { await invoke('install_update'); }
    catch (error) {
      $('#update-install').disabled = false;
      toast(String(error), 'error', { duration: 7000 });
    }
  }

  async function downloadUpdate(installAfter = false) {
    if (state.updateBusy || !state.update?.available) return;
    if (state.update.downloaded) {
      if (installAfter) await installDownloadedUpdate();
      return;
    }
    state.updateBusy = true;
    renderUpdate({ ...state.update, downloading: true });
    if (installAfter) {
      $('#update-modal-progress').hidden = false;
      $('#update-install').disabled = true;
      $('#update-install').textContent = 'Скачивание…';
    }
    try {
      const info = await invoke('download_update');
      renderUpdate(info);
      if (installAfter) await installDownloadedUpdate();
      else showUpdateAvailable();
    } catch (error) {
      $('#update-status').textContent = String(error);
      $('#update-progress').hidden = true;
      $('#update-modal-progress').hidden = true;
      $('#update-check').disabled = false;
      $('#update-install').disabled = false;
      $('#update-install').textContent = 'Повторить';
      toast(String(error), 'error', { duration: 7000 });
    } finally {
      state.updateBusy = false;
    }
  }

  async function checkForUpdates(manual = false) {
    if (state.updateBusy) return;
    if (state.update?.available) { showUpdateAvailable(); return; }
    state.updateBusy = true;
    $('#update-check').disabled = true;
    $('#update-status').textContent = 'Проверка обновлений…';
    try {
      const info = await invoke('check_for_updates');
      state.updateBusy = false;
      renderUpdate(info);
      if (info.available) showUpdateAvailable();
      else if (manual) toast('Установлена последняя версия.', 'success');
    } catch (error) {
      $('#update-status').textContent = 'Не удалось проверить обновления. Повторите попытку позже.';
      $('#update-check').disabled = false;
      if (manual) toast(String(error), 'error', { duration: 6000 });
    } finally {
      state.updateBusy = false;
      if (!state.update?.downloading) $('#update-check').disabled = false;
    }
  }

  function openModal(modal) {
    modal.hidden = false;
    $('[data-close-modal]', modal)?.focus();
  }

  function closeModals() {
    elements.exportModal.hidden = true;
    elements.helpModal.hidden = true;
    elements.updateModal.hidden = true;
    state.updatePromptShown = false;
  }

  function resetTrim() {
    state.start = 0;
    state.end = state.duration;
    seek(0);
    updateTimeline();
  }

  function videoRect() {
    const rect = $('#preview-stage').getBoundingClientRect();
    const aspect = state.originalWidth / state.originalHeight;
    let width = rect.width;
    let height = width / aspect;
    if (height > rect.height) { height = rect.height; width = height * aspect; }
    return { left: (rect.width - width) / 2, top: (rect.height - height) / 2, width, height };
  }

  function renderCrop() {
    const frame = $('.crop-frame');
    if (!state.crop) return;
    const rect = videoRect();
    frame.style.left = `${rect.left + state.crop.x * rect.width}px`;
    frame.style.top = `${rect.top + state.crop.y * rect.height}px`;
    frame.style.width = `${state.crop.width * rect.width}px`;
    frame.style.height = `${state.crop.height * rect.height}px`;
    frame.style.aspectRatio = 'auto';
    const width = Math.round(state.crop.width * state.originalWidth) & ~1;
    const height = Math.round(state.crop.height * state.originalHeight) & ~1;
    $('#crop-summary').textContent = sectionOpen('crop') ? `${width} × ${height} · ${state.cropRatio}` : 'Не применяется';
    $('.crop-label').textContent = `${width} × ${height} · перетащите рамку`;
  }

  function setCropRatio(ratio) {
    state.cropRatio = ratio;
    $$('#ratio-grid button').forEach((button) => button.classList.toggle('active', button.dataset.ratio === ratio));
    if (ratio === 'free') {
      state.crop = null;
      state.cropVisible = false;
      elements.cropOverlay.hidden = true;
      $('#crop-preview-button').innerHTML = `${icon('crop')}Показать область на превью`;
      ensurePreciseForTransforms();
      updateOutputName();
      return;
    }
    const [rx, ry] = ratio.split(':').map(Number);
    const target = rx / ry;
    const source = state.originalWidth / state.originalHeight;
    let width = .8;
    let height = width * source / target;
    if (height > .8) { height = .8; width = height * target / source; }
    state.crop = { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
    state.cropVisible = true;
    elements.cropOverlay.hidden = !sectionOpen('crop');
    $('#crop-preview-button').innerHTML = `${icon('crop')}Скрыть область на превью`;
    requestAnimationFrame(renderCrop);
    ensurePreciseForTransforms();
    updateOutputName();
  }

  function setupCropDrag() {
    const frame = $('.crop-frame');
    let drag = null;
    frame.addEventListener('pointerdown', (event) => {
      if (!state.crop) return;
      const handle = event.target.closest('.crop-handle');
      const mode = handle ? ['tl', 'tr', 'bl', 'br'].find((name) => handle.classList.contains(`ch-${name}`)) : 'move';
      drag = { mode, x: event.clientX, y: event.clientY, crop: { ...state.crop }, rect: videoRect() };
      frame.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    frame.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const dx = (event.clientX - drag.x) / drag.rect.width;
      const dy = (event.clientY - drag.y) / drag.rect.height;
      const original = drag.crop;
      let next = { ...original };
      const min = .04;
      if (drag.mode === 'move') {
        next.x = clamp(original.x + dx, 0, 1 - original.width);
        next.y = clamp(original.y + dy, 0, 1 - original.height);
      } else {
        const left = drag.mode === 'tl' || drag.mode === 'bl';
        const top = drag.mode === 'tl' || drag.mode === 'tr';
        if (left) {
          next.x = clamp(original.x + dx, 0, original.x + original.width - min);
          next.width = original.width + original.x - next.x;
        } else {
          next.width = clamp(original.width + dx, min, 1 - original.x);
        }
        if (top) {
          next.y = clamp(original.y + dy, 0, original.y + original.height - min);
          next.height = original.height + original.y - next.y;
        } else {
          next.height = clamp(original.height + dy, min, 1 - original.y);
        }
        const [rx, ry] = state.cropRatio.split(':').map(Number);
        if (rx && ry) {
          next.height = next.width * state.originalWidth * ry / (state.originalHeight * rx);
          if (next.y + next.height > 1) {
            next.height = 1 - next.y;
            next.width = next.height * state.originalHeight * rx / (state.originalWidth * ry);
          }
          if (left) next.x = original.x + original.width - next.width;
        }
      }
      state.crop = next;
      renderCrop();
      updateOutputName();
    });
    const stop = (event) => {
      drag = null;
      if (frame.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
    };
    frame.addEventListener('pointerup', stop);
    frame.addEventListener('pointercancel', stop);
  }

  function renderAudioTracks() {
    $$('#audio-panel .audio-track').forEach((track) => track.remove());
    const output = $('.audio-output');
    state.audio.forEach((track) => {
      const article = document.createElement('article');
      article.className = `audio-track${track.enabled ? '' : ' disabled'}`;
      article.dataset.index = track.index;
      const channels = track.channels === 1 ? 'Mono' : track.channels === 2 ? 'Stereo' : `${track.channels} каналов`;
      const details = [track.language, track.codec, channels].filter(Boolean).join(' · ');
      article.innerHTML = `
        <div class="audio-track-head"><span class="track-number">${String(track.number).padStart(2, '0')}</span><div><strong>${escapeHtml(track.name)}</strong><span>${escapeHtml(details)}</span></div><label class="switch"><input class="track-enabled" type="checkbox" ${track.enabled ? 'checked' : ''} aria-label="Включить дорожку ${track.number}"><span class="slider"></span></label></div>
        <div class="track-volume">${icon('volume')}<input class="audio-volume" type="range" min="0" max="200" value="${Math.round(track.volume * 100)}" aria-label="Громкость дорожки ${track.number}"><span>${Math.round(track.volume * 100)}%</span></div>
        <div class="track-footer"><span>${track.sampleRate ? `${(track.sampleRate / 1000).toFixed(1).replace('.0', '')} kHz` : 'Частота не указана'}${track.bitRate ? ` · ${Math.round(track.bitRate / 1000)} kb/s` : ''}</span><button class="text-button track-mute" type="button">${track.volume ? 'Выключить звук' : 'Вернуть громкость'}</button></div>`;
      output.before(article);
      const enabled = $('.track-enabled', article);
      const volume = $('.audio-volume', article);
      setRangeFill(volume);
      enabled.addEventListener('change', () => {
        track.enabled = enabled.checked;
        article.classList.toggle('disabled', !track.enabled);
        syncPreviewAudio();
        updateOutputName();
      });
      volume.addEventListener('input', () => {
        track.volume = Number(volume.value) / 100;
        setRangeFill(volume);
        $('.track-volume > span', article).textContent = `${volume.value}%`;
        $('.track-mute', article).textContent = track.volume ? 'Выключить звук' : 'Вернуть громкость';
        syncPreviewAudio();
      });
      $('.track-mute', article).addEventListener('click', () => {
        volume.value = track.volume ? 0 : 100;
        volume.dispatchEvent(new Event('input'));
      });
    });
    $('.tab-count').textContent = state.audio.length;
    $('.audio-overview .soft-badge').textContent = `${state.audio.length} дорожек`;
    $('.audio-overview').hidden = state.audio.length === 0;
    if (!state.audio.length) {
      const empty = document.createElement('div');
      empty.className = 'inline-note audio-track';
      empty.textContent = 'В исходном файле нет аудиодорожек.';
      output.before(empty);
    }
    syncPreviewAudio();
  }

  function resetSettings() {
    selectPreset('balance');
    elements.container.value = 'MP4';
    $('#width-input').value = String(state.originalWidth);
    $('#height-input').value = String(state.originalHeight);
    $('#resolution-summary').textContent = `Как в оригинале · ${state.originalWidth} × ${state.originalHeight}`;
    $$('#resolution-presets button').forEach((button) => button.classList.toggle('active', button.textContent === 'Оригинал'));
    setCropRatio('free');
    resetTrim();
    $$('#trim-mode button').forEach((button) => button.classList.toggle('active', button.dataset.mode === 'precise'));
    state.audio.forEach((track) => { track.enabled = true; track.volume = 1; });
    renderAudioTracks();
    $('#audio-codec').value = 'aac';
    $('#audio-bitrate').value = '192';
    $('#keep-metadata').checked = true;
    $('#keep-subtitles').checked = true;
    setExportKind('video');
    updateAudioSummary();
    updateOutputName();
    scheduleSave();
    toast('Настройки сброшены.', 'success');
  }

  function updateAudioSummary() {
    const codec = $('#audio-codec').value;
    const bitrate = ['flac', 'wav'].includes(codec) ? '' : ` · ${$('#audio-bitrate').value} kb/s`;
    $('.audio-output summary small').textContent = $('.audio-output').open ? `${$('#audio-codec').selectedOptions[0].textContent}${bitrate}` : 'Не применяется';
    $('#audio-bitrate').disabled = ['flac', 'wav'].includes(codec);
    updateOutputName();
    scheduleSave();
  }

  function setExportKind(kind) {
    state.exportKind = kind;
    $$('#export-kind button').forEach((button) => button.classList.toggle('active', button.dataset.kind === kind));
    $$('#image-format button').forEach((button) => button.classList.toggle('active', button.dataset.format.toLowerCase() === kind));
    const audioCodec = $('#audio-codec');
    let wav = $('option[value="wav"]', audioCodec);
    if (kind === 'audio') {
      if (!wav) {
        wav = document.createElement('option');
        wav.value = 'wav'; wav.textContent = 'WAV';
        audioCodec.append(wav);
      }
      if (audioCodec.value === 'original') audioCodec.value = 'mp3';
      $('.audio-output').open = true;
    } else {
      if (audioCodec.value === 'wav') audioCodec.value = 'aac';
      wav?.remove();
    }
    $('#single-frame').disabled = kind === 'gif' || kind === 'audio';
    if (kind === 'gif') $('#single-frame').checked = false;
    $('#fps-range').disabled = !(kind === 'gif' || (['png', 'jpg'].includes(kind) && !$('#single-frame').checked));
    $('#fps-value').textContent = $('#fps-range').disabled ? 'Для GIF и серии' : `${$('#fps-range').value} FPS`;
    elements.container.disabled = kind !== 'video';
    $$('#trim-mode button').forEach((button) => button.disabled = kind !== 'video');
    $('.audio-overview div span').textContent = kind === 'audio' ? 'Выбранные дорожки будут смешаны в одну' : 'Настройте каждую дорожку отдельно';
    updateAudioSummary();
  }

  function exportSettings(output) {
    const options = videoOptions();
    const singleImage = ['png', 'jpg'].includes(state.exportKind) && $('#single-frame').checked;
    return {
      input: state.media.path,
      output,
      kind: state.exportKind,
      start: singleImage ? state.position : state.start,
      end: singleImage ? state.position + .001 : state.end,
      copyVideo: options.copyVideo,
      codec: options.codec,
      encoder: options.encoder,
      quality: options.quality,
      width: clamp(options.width, 16, 16384),
      height: clamp(options.height, 16, 16384),
      originalWidth: state.originalWidth,
      originalHeight: state.originalHeight,
      crop: options.crop,
      fps: Number($('#fps-range').value),
      singleFrame: $('#single-frame').checked,
      audio: state.audio.map((track) => ({ index: track.index, enabled: track.enabled, volume: track.volume })),
      audioCodec: options.audioCodec,
      audioBitrate: Number($('#audio-bitrate').value),
      keepMetadata: options.keepMetadata,
      keepSubtitles: options.keepSubtitles
    };
  }

  function showExportProgress(name) {
    $('#export-modal-title').textContent = 'Экспорт';
    $('#export-modal-eyebrow').textContent = 'FFmpeg';
    $('#export-modal-message').textContent = 'Обработка файла…';
    $('#export-modal-icon').innerHTML = icon('film');
    $('#export-progress').hidden = false;
    $('#export-progress-bar').style.width = '0%';
    $('#export-progress-value').textContent = '0%';
    $('#review-file').textContent = name;
    const options = videoOptions();
    const format = options.copyVideo ? 'Без перекодирования' : options.compression ? options.codec : `Авто · ${options.codec}`;
    $('#review-format').textContent = state.exportKind === 'video' ? `${options.extension.toUpperCase()} · ${format}` : currentExtension().toUpperCase();
    $('#review-trim').textContent = `${formatTime(state.start)} — ${formatTime(state.end)}`;
    $('#cancel-export').hidden = false;
    $('#cancel-export').disabled = false;
    $('#reveal-result').hidden = true;
    $('#export-done').hidden = true;
    openModal(elements.exportModal);
  }

  async function startExport() {
    if (state.activeJob) return;
    if (!desktop || state.isDemo || !state.media?.path) {
      toast('Для экспорта откройте видео в приложении FFConverter.', 'warning');
      return;
    }
    if (state.end <= state.start) { toast('Выберите фрагмент на таймлайне.', 'warning'); return; }
    if (state.exportKind === 'audio' && !selectedAudioTracks().length) {
      toast('Выберите хотя бы одну аудиодорожку.', 'warning');
      return;
    }
    let output;
    const extension = currentExtension();
    const sequence = ['png', 'jpg'].includes(state.exportKind) && !$('#single-frame').checked;
    try {
      if (sequence) {
        output = await api.dialog.open({ directory: true, multiple: false, title: 'Папка для последовательности кадров' });
      } else {
        output = await api.dialog.save({
          title: 'Сохранить результат',
          defaultPath: outputName(),
          filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
        });
      }
    } catch (error) { toast(String(error), 'error'); return; }
    if (!output) return;
    state.exportOutput = output;
    showExportProgress(sequence ? `Кадры ${extension.toUpperCase()}` : output.split(/[\\/]/).pop());
    try {
      state.activeJob = await invoke('start_export', { settings: exportSettings(output) });
      updateOutputName();
    } catch (error) {
      state.activeJob = null;
      $('#export-modal-title').textContent = 'Не удалось начать экспорт';
      $('#export-modal-message').textContent = String(error);
      $('#export-progress').hidden = true;
      $('#cancel-export').hidden = true;
      $('#export-done').hidden = false;
      updateOutputName();
    }
  }

  function finishExport(event) {
    if (event.jobId !== state.activeJob) return;
    state.activeJob = null;
    $('#export-progress').hidden = true;
    $('#cancel-export').hidden = true;
    $('#export-done').hidden = false;
    const done = event.status === 'done';
    if (done && event.output) state.exportOutput = event.output;
    $('#export-modal-title').textContent = done ? 'Готово' : event.status === 'cancelled' ? 'Экспорт отменён' : 'Ошибка экспорта';
    $('#export-modal-eyebrow').textContent = done ? 'Файл сохранён' : 'FFmpeg';
    $('#export-modal-message').textContent = event.message;
    $('#export-modal-icon').innerHTML = icon(done ? 'check' : event.status === 'cancelled' ? 'close' : 'help');
    $('#reveal-result').hidden = !done;
    if (state.update?.downloaded) {
      $('#update-install').disabled = false;
      $('#update-install').textContent = 'Обновить и перезапустить';
    }
    updateOutputName();
  }

  function scheduleSave() {
    if (!desktop || !state.settingsReady) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      const settings = {
        codec: elements.codec.value,
        encoder: elements.encoder.value,
        quality: Number(elements.quality.value),
        container: elements.container.value,
        audioCodec: $('#audio-codec').value,
        audioBitrate: Number($('#audio-bitrate').value),
        accentColor: $('#accent-color').value,
        contextMenu: Boolean(state.settings.contextMenu)
      };
      state.settings = { ...state.settings, ...settings };
      invoke('save_settings', { settings: state.settings }).catch(() => {});
    }, 350);
  }

  function prepareDynamicUI() {
    $('#demo-button').hidden = desktop;
    ['compression', 'conversion', 'resolution', 'crop', 'frames'].forEach((name, index) => {
      const section = $$('#video-panel > .setting-section')[index];
      section.id = `${name}-section`;
      section.addEventListener('toggle', () => {
        if (name === 'crop') {
          elements.cropOverlay.hidden = !section.open || !state.cropVisible || !state.crop;
          if (section.open && state.crop) requestAnimationFrame(renderCrop);
        }
        if (['crop', 'resolution'].includes(name)) ensurePreciseForTransforms();
        updateOutputName();
      });
    });
    $('.audio-output').addEventListener('toggle', updateAudioSummary);
    const exportKind = document.createElement('div');
    exportKind.className = 'export-kind-wrap';
    exportKind.innerHTML = '<span>Тип результата</span><div class="segmented full export-kind" id="export-kind"><button class="active" data-kind="video" type="button">Видео</button><button data-kind="png" type="button">PNG</button><button data-kind="jpg" type="button">JPG</button><button data-kind="gif" type="button">GIF</button><button data-kind="audio" type="button">Аудио</button></div>';
    $('.output-name').before(exportKind);
    const metadata = $$('#video-panel .switch-row input[type="checkbox"]');
    metadata[0].id = 'keep-metadata';
    metadata[1].id = 'keep-subtitles';
    const audioSelects = $$('.audio-output select');
    audioSelects[0].id = 'audio-codec';
    audioSelects[1].id = 'audio-bitrate';
    audioSelects[0].innerHTML = '<option value="aac">AAC / M4A</option><option value="mp3">MP3</option><option value="opus">Opus / OGG</option><option value="flac">FLAC</option><option value="original">Оригинал</option>';
    audioSelects[1].innerHTML = '<option value="128">128 kb/s</option><option value="192" selected>192 kb/s</option><option value="256">256 kb/s</option><option value="320">320 kb/s</option>';
    const resolution = $('#resolution-presets');
    if (!$$('button', resolution).some((button) => button.textContent === '1080p')) {
      const fullHd = document.createElement('button');
      fullHd.dataset.width = '1920'; fullHd.dataset.height = '1080'; fullHd.textContent = '1080p'; fullHd.type = 'button';
      fullHd.addEventListener('click', () => selectResolution(fullHd));
      $('[data-height="720"]', resolution).before(fullHd);
    }
    elements.exportModal.querySelector('.modal-card').innerHTML = `
      <button class="icon-button modal-close" data-close-modal type="button" aria-label="Закрыть">${icon('close')}</button>
      <span class="modal-icon" id="export-modal-icon">${icon('film')}</span>
      <span class="eyebrow modal-eyebrow" id="export-modal-eyebrow">FFmpeg</span>
      <h2 id="export-modal-title">Экспорт</h2>
      <p id="export-modal-message">Обработка файла…</p>
      <div class="export-progress" id="export-progress"><div><span id="export-progress-value">0%</span></div><div class="export-progress-track"><span id="export-progress-bar"></span></div></div>
      <div class="export-review"><div><span>Файл</span><strong id="review-file"></strong></div><div><span>Формат</span><strong id="review-format"></strong></div><div><span>Фрагмент</span><strong id="review-trim"></strong></div></div>
      <div class="modal-actions"><button class="btn btn-dark full-width" id="cancel-export" type="button">Отменить экспорт</button><button class="btn btn-primary full-width" id="reveal-result" type="button" hidden>Показать в проводнике</button><button class="btn btn-dark full-width" id="export-done" data-close-modal type="button" hidden>Закрыть</button></div>`;
    $('.modal-hint', elements.helpModal).textContent = desktop
      ? 'Предпросмотр использует облегчённую копию для неподдерживаемых форматов. Экспорт всегда выполняется из исходного файла.'
      : 'Браузерная версия предназначена для просмотра интерфейса. Экспорт доступен в приложении FFConverter.';
    if (desktop) {
      const context = document.createElement('label');
      context.className = 'switch-row context-setting';
      context.innerHTML = '<span><strong>Открыть через FFConverter</strong><small>Пункт в контекстном меню видеофайлов</small></span><span class="switch"><input id="context-menu-setting" type="checkbox"><span class="slider"></span></span>';
      $('.modal-hint', elements.helpModal).before(context);
      const window = api.window.getCurrentWindow();
      $$('[data-window-action]').forEach((button) => button.addEventListener('click', async () => {
        try {
          if (button.dataset.windowAction === 'minimize') await window.minimize();
          if (button.dataset.windowAction === 'maximize') await window.toggleMaximize();
          if (button.dataset.windowAction === 'close') {
            if (state.activeJob) await invoke('cancel_export', { jobId: state.activeJob }).catch(() => {});
            await window.close();
          }
        } catch (error) { toast(String(error), 'error'); }
      }));
    }
    $$('#export-kind button').forEach((button) => button.addEventListener('click', () => setExportKind(button.dataset.kind)));
    $$('[data-close-modal]').forEach((button) => button.addEventListener('click', closeModals));
    $('#cancel-export').addEventListener('click', async () => {
      if (!state.activeJob) return;
      $('#cancel-export').disabled = true;
      try { await invoke('cancel_export', { jobId: state.activeJob }); }
      catch (error) { toast(String(error), 'error'); $('#cancel-export').disabled = false; }
    });
    $('#reveal-result').addEventListener('click', () => invoke('reveal_file', { path: state.exportOutput }).catch((error) => toast(String(error), 'error')));
    $('#audio-codec').addEventListener('change', updateAudioSummary);
    $('#audio-bitrate').addEventListener('change', updateAudioSummary);
    $('#accent-color').addEventListener('input', (event) => {
      applyAccent(event.target.value);
      scheduleSave();
    });
    $('#keep-metadata').addEventListener('change', scheduleSave);
    $('#keep-subtitles').addEventListener('change', scheduleSave);
  }

  async function initializeDesktop() {
    if (!desktop) return;
    try {
      state.settings = await invoke('load_settings');
      applyAccent(state.settings.accentColor);
      if (state.settings.codec) elements.codec.value = state.settings.codec;
      if (state.settings.encoder) elements.encoder.value = state.settings.encoder;
      if (elements.encoder.selectedIndex < 0 || elements.encoder.selectedOptions[0].disabled) elements.encoder.value = 'CPU';
      if (state.settings.quality) elements.quality.value = state.settings.quality;
      if (state.settings.container) elements.container.value = state.settings.container;
      if (state.settings.audioCodec) $('#audio-codec').value = state.settings.audioCodec;
      if (elements.container.value === 'WebM') {
        elements.codec.value = 'AV1';
        elements.encoder.value = 'CPU';
        if (['aac', 'flac', 'mp3', 'original'].includes($('#audio-codec').value)) $('#audio-codec').value = 'opus';
      }
      if (state.settings.audioBitrate) $('#audio-bitrate').value = state.settings.audioBitrate;
      $('#context-menu-setting').checked = Boolean(state.settings.contextMenu);
      $$('#preset-grid button').forEach((button) => {
        const preset = presets[button.dataset.preset];
        button.classList.toggle('active', preset && preset.codec === elements.codec.value && preset.encoder === elements.encoder.value && preset.quality === Number(elements.quality.value));
      });
      updateQuality(); updateCompressionSummary(); updateAudioSummary();
    } catch {}
    state.settingsReady = true;
    const currentWindow = api.window.getCurrentWindow();
    await currentWindow.show();
    await currentWindow.setFocus();
    $('#context-menu-setting').addEventListener('change', async (event) => {
      const enabled = event.target.checked;
      try {
        await invoke('set_context_menu', { enabled });
        state.settings.contextMenu = enabled;
        scheduleSave();
        toast(enabled ? 'Пункт добавлен в контекстное меню.' : 'Пункт удалён из контекстного меню.', 'success');
      } catch (error) {
        event.target.checked = !enabled;
        toast(String(error), 'error');
      }
    });
    await api.event.listen('export-progress', ({ payload }) => {
      if (payload.jobId !== state.activeJob) return;
      const percent = Math.round(payload.percent);
      $('#export-progress-bar').style.width = `${percent}%`;
      $('#export-progress-value').textContent = `${percent}% · ${formatTime(payload.time)}`;
    });
    await api.event.listen('export-finished', ({ payload }) => finishExport(payload));
    await api.event.listen('update-progress', ({ payload }) => {
      $('#update-progress').hidden = false;
      $('#update-progress-bar').style.width = `${payload.percent}%`;
      $('#update-progress-value').textContent = `${payload.percent}%`;
      $('#update-modal-progress-bar').style.width = `${payload.percent}%`;
      $('#update-modal-progress-value').textContent = `${payload.percent}%`;
      $('#update-install').textContent = `Скачивание… ${payload.percent}%`;
      if (state.update) $('#update-status').textContent = `Скачивание версии ${state.update.latestVersion}…`;
    });
    const updateError = await invoke('take_update_error');
    if (updateError) toast(`Обновление не установлено: ${updateError}`, 'error', { duration: 8000 });
    currentWindow.onDragDropEvent((event) => {
      if (event.payload.type === 'over') elements.dropZone.classList.add('dragover');
      if (event.payload.type === 'leave') elements.dropZone.classList.remove('dragover');
      if (event.payload.type === 'drop') {
        elements.dropZone.classList.remove('dragover');
        const path = event.payload.paths[0];
        if (path) openMediaPath(path);
      }
    }).catch(() => {});
    try {
      const path = await invoke('initial_file');
      if (path) openMediaPath(path);
    } catch {}
    checkForUpdates(false);
    try {
      state.encoderSupport = await invoke('encoder_support');
      updateEncoderOptions();
      $('#encoder-note').textContent = 'Если выбранное аппаратное кодирование недоступно, пресет автоматически использует CPU.';
      if (elements.encoder.selectedOptions[0]?.disabled) {
        elements.encoder.value = 'CPU';
        updateQuality(); updateCompressionSummary();
      }
    } catch (error) { toast(String(error), 'warning'); }
  }

  elements.fileInput.addEventListener('change', () => { handleFile(elements.fileInput.files[0]); elements.fileInput.value = ''; });
  $('#browse-button').addEventListener('click', (event) => { event.stopPropagation(); openFiles(); });
  $('#change-file-button').addEventListener('click', openFiles);
  $('#demo-button').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openWorkspace(); });
  $('#home-button').addEventListener('click', showWelcome);
  $('.welcome-header .brand').addEventListener('click', (event) => event.preventDefault());
  elements.dropZone.addEventListener('click', (event) => { if (!event.target.closest('button')) openFiles(); });
  if (!desktop) {
    ['dragenter', 'dragover'].forEach((type) => elements.dropZone.addEventListener(type, (event) => { event.preventDefault(); elements.dropZone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((type) => elements.dropZone.addEventListener(type, (event) => { event.preventDefault(); elements.dropZone.classList.remove('dragover'); }));
    elements.dropZone.addEventListener('drop', (event) => handleFile(event.dataTransfer.files[0]));
  }

  elements.video.addEventListener('loadedmetadata', () => {
    if (desktop || state.isDemo || !Number.isFinite(elements.video.duration)) return;
    state.duration = elements.video.duration;
    state.start = 0; state.end = state.duration;
    state.originalWidth = elements.video.videoWidth || 1920;
    state.originalHeight = elements.video.videoHeight || 1080;
    $('#preview-resolution').textContent = `${state.originalWidth} × ${state.originalHeight}`;
    $('#width-input').value = String(state.originalWidth);
    $('#height-input').value = String(state.originalHeight);
    updateOutputName(); updateTimeline();
  });
  elements.video.addEventListener('timeupdate', () => {
    if (state.isDemo) return;
    if (elements.video.currentTime >= state.end && state.playing) {
      elements.video.pause(); setPlaying(false); seek(state.start); return;
    }
    seek(elements.video.currentTime, true);
    syncAudioPlayback();
  });
  elements.video.addEventListener('play', () => {
    setPlaying(true);
    if (state.audioContext) state.audioContext.resume().catch(() => {});
    syncAudioPlayback();
  });
  elements.video.addEventListener('seeked', syncAudioPlayback);
  elements.video.addEventListener('pause', () => {
    setPlaying(false);
    state.audioPlayers.forEach((player) => player.audio.pause());
  });
  elements.video.addEventListener('ended', () => {
    setPlaying(false);
    state.audioPlayers.forEach((player) => player.audio.pause());
    seek(state.start);
  });
  elements.video.addEventListener('error', () => {
    if (!elements.video.getAttribute('src')) return;
    setPlaying(false);
    if (!desktop) toast('Этот формат не поддерживается браузерным предпросмотром.', 'warning');
  });
  elements.centerPlay.addEventListener('click', togglePlayback);
  elements.playButton.addEventListener('click', togglePlayback);
  $('#rewind-button').addEventListener('click', () => seek(state.position - 5));
  $('#forward-button').addEventListener('click', () => seek(state.position + 5));
  $('#mute-button').addEventListener('click', () => {
    state.masterMuted = !state.masterMuted;
    syncPreviewAudio();
  });
  $('#fullscreen-button').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('#preview-stage').requestFullscreen();
    } catch { toast('Полноэкранный режим недоступен.', 'warning'); }
  });

  let dragType = null;
  function moveTimeline(event) {
    const rect = elements.timeline.getBoundingClientRect();
    const value = clamp(((event.clientX - rect.left) / rect.width) * state.duration, 0, state.duration);
    const gap = Math.min(.1, state.duration / 10);
    if (dragType === 'start') state.start = clamp(Math.min(value, state.end - gap), 0, state.duration);
    if (dragType === 'end') state.end = clamp(Math.max(value, state.start + gap), 0, state.duration);
    if (dragType === 'playhead') scrubTo(value);
    updateTimeline();
  }
  elements.timeline.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragType = event.target.closest('[data-drag]')?.dataset.drag || 'playhead';
    state.scrubbing = dragType === 'playhead' && !state.isDemo;
    if (state.scrubbing) {
      state.resumeAfterScrub = state.playing && !elements.video.paused;
      elements.video.pause();
      state.audioPlayers.forEach((player) => player.audio.pause());
    }
    elements.timeline.setPointerCapture(event.pointerId);
    moveTimeline(event); event.preventDefault();
  });
  elements.timeline.addEventListener('pointermove', (event) => { if (dragType) moveTimeline(event); });
  const finishTimelineDrag = (event) => {
    dragType = null;
    if (state.scrubbing) {
      const resume = state.resumeAfterScrub;
      state.scrubbing = false;
      state.resumeAfterScrub = false;
      seek(state.position);
      if (resume) togglePlayback();
    }
    if (event && elements.timeline.hasPointerCapture(event.pointerId)) elements.timeline.releasePointerCapture(event.pointerId);
  };
  elements.timeline.addEventListener('pointerup', finishTimelineDrag);
  elements.timeline.addEventListener('pointercancel', finishTimelineDrag);
  $$('[data-drag]').forEach((handle) => handle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : .1;
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    if (handle.dataset.drag === 'start') state.start = event.key === 'Home' ? 0 : event.key === 'End' ? state.end - .1 : clamp(state.start + direction * step, 0, state.end - .1);
    else if (handle.dataset.drag === 'end') state.end = event.key === 'Home' ? state.start + .1 : event.key === 'End' ? state.duration : clamp(state.end + direction * step, state.start + .1, state.duration);
    else seek(event.key === 'Home' ? 0 : event.key === 'End' ? state.duration : state.position + direction * step);
    updateTimeline();
  }));
  $('#reset-trim').addEventListener('click', resetTrim);

  $$('.inspector-tabs button').forEach((tab) => tab.addEventListener('click', () => {
    $$('.inspector-tabs button').forEach((button) => { const active = button === tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
    $$('.settings-panel').forEach((panel) => { panel.hidden = panel.id !== tab.dataset.panel; });
    $('.inspector-scroll').scrollTop = 0;
  }));
  $$('#preset-grid button').forEach((button) => button.addEventListener('click', () => selectPreset(button.dataset.preset)));
  elements.quality.addEventListener('input', () => { updateQuality(); markCustomPreset(); });
  elements.codec.addEventListener('change', () => {
    updateEncoderOptions();
    if (elements.encoder.selectedOptions[0]?.disabled) elements.encoder.value = 'CPU';
    updateQuality(); markCustomPreset();
  });
  elements.encoder.addEventListener('change', () => { updateQuality(); markCustomPreset(); });
  elements.container.addEventListener('change', () => {
    if (elements.container.value === 'WebM') {
      if (elements.codec.value !== 'AV1') {
        elements.codec.value = 'AV1'; elements.encoder.value = 'CPU'; updateQuality(); markCustomPreset();
      }
      if (['aac', 'flac', 'mp3', 'original'].includes($('#audio-codec').value)) $('#audio-codec').value = 'opus';
      updateAudioSummary();
      toast('Для WebM выбраны совместимые кодеки AV1 и Opus.', 'info');
    }
    updateOutputName(); scheduleSave();
  });
  $$('#trim-mode button').forEach((button) => button.addEventListener('click', () => {
    $$('#trim-mode button').forEach((item) => item.classList.toggle('active', item === button));
    if (button.dataset.mode === 'fast') {
      ensurePreciseForTransforms();
      if (button.classList.contains('active')) toast('Без перекодирования. Границы фрагмента зависят от ключевых кадров.', 'info', { duration: 4500 });
    }
    updateOutputName();
  }));

  function selectResolution(button) {
    $$('#resolution-presets button').forEach((item) => item.classList.toggle('active', item === button));
    $('#width-input').value = button.textContent === 'Оригинал' ? state.originalWidth : button.dataset.width;
    $('#height-input').value = button.textContent === 'Оригинал' ? state.originalHeight : button.dataset.height;
    $('#resolution-summary').textContent = `${button.textContent} · ${$('#width-input').value} × ${$('#height-input').value}`;
    ensurePreciseForTransforms();
    updateOutputName();
  }
  $$('#resolution-presets button').forEach((button) => button.addEventListener('click', () => selectResolution(button)));
  function dimensionChanged(changed) {
    const width = $('#width-input'); const height = $('#height-input');
    const value = clamp(Math.round(Number(changed.value) / 2) * 2 || 16, 16, 16384);
    changed.value = value;
    if ($('#aspect-lock').checked) {
      const aspect = state.crop ? state.crop.width * state.originalWidth / (state.crop.height * state.originalHeight) : state.originalWidth / state.originalHeight;
      const other = changed === width ? height : width;
      other.value = Math.max(16, Math.round((changed === width ? value / aspect : value * aspect) / 2) * 2);
    }
    $$('#resolution-presets button').forEach((button) => button.classList.remove('active'));
    $('#resolution-summary').textContent = `Пользовательское · ${width.value} × ${height.value}`;
    ensurePreciseForTransforms();
    updateOutputName();
  }
  [$('#width-input'), $('#height-input')].forEach((input) => input.addEventListener('change', () => dimensionChanged(input)));

  $$('#ratio-grid button').forEach((button) => button.addEventListener('click', () => setCropRatio(button.dataset.ratio)));
  $('#crop-preview-button').addEventListener('click', () => {
    if (!state.crop) { setCropRatio('16:9'); return; }
    state.cropVisible = !state.cropVisible;
    elements.cropOverlay.hidden = !state.cropVisible;
    $('#crop-preview-button').innerHTML = `${icon('crop')}${state.cropVisible ? 'Скрыть' : 'Показать'} область на превью`;
  });
  setupCropDrag();
  window.addEventListener('resize', () => { if (state.crop) renderCrop(); });

  $$('#image-format button').forEach((button) => button.addEventListener('click', () => setExportKind(button.dataset.format.toLowerCase())));
  $('#single-frame').addEventListener('change', () => { setExportKind(state.exportKind); });
  $('#fps-range').addEventListener('input', () => {
    setRangeFill($('#fps-range'));
    if (!$('#fps-range').disabled) $('#fps-value').textContent = `${$('#fps-range').value} FPS`;
    updateOutputName();
  });

  $('#reset-settings').addEventListener('click', resetSettings);
  $('#help-button').addEventListener('click', () => openModal(elements.helpModal));
  $('#welcome-help-button').addEventListener('click', () => openModal(elements.helpModal));
  $('#export-button').addEventListener('click', startExport);
  $('#loading-change-file').addEventListener('click', openFiles);
  $('#loading-home').addEventListener('click', showWelcome);
  $('#update-check').addEventListener('click', () => {
    if (state.update?.available) {
      state.updatePromptShown = false;
      showUpdateAvailable();
    } else {
      checkForUpdates(true);
    }
  });
  $('#update-install').addEventListener('click', async () => {
    if (state.activeJob) { toast('Дождитесь завершения экспорта.', 'warning'); return; }
    if (state.update?.downloaded) await installDownloadedUpdate();
    else await downloadUpdate(true);
  });
  $$('.app-modal').forEach((modal) => modal.addEventListener('click', (event) => { if (event.target === modal) closeModals(); }));
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModals();
      if (state.crop) { state.cropVisible = false; elements.cropOverlay.hidden = true; }
      return;
    }
    if (elements.workspace.hidden || !elements.exportModal.hidden || !elements.helpModal.hidden || !elements.updateModal.hidden) return;
    if (event.target.matches('input, select, textarea, button, summary')) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
    if (event.key === 'ArrowLeft') seek(state.position - 5);
    if (event.key === 'ArrowRight') seek(state.position + 5);
    if (event.key.toLowerCase() === 'r') resetTrim();
  });

  prepareDynamicUI();
  $$('input[type="range"]').forEach(setRangeFill);
  setExportKind('video');
  updateQuality();
  updateTimeline();
  updateAudioSummary();
  Whitely.init();
  initializeDesktop();
})();
