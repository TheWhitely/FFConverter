/* Whitely Design System v2.0 — библиотека компонентов.
 * Классический скрипт (не модуль), чтобы работать с file:// без сборки.
 * Публичный API — window.Whitely: init(), toast(), openModal(), closeModal()
 * и точечные init*-функции. После загрузки DOM вызови Whitely.init().
 */
(function () {
  'use strict';

  /* ===== Тосты =====
   * Вход, выход и FLIP-сдвиг стопки — целиком через Web Animations API,
   * трансформации складываются (composite:'add'). Смесь CSS-keyframes и
   * WAAPI в v1 боролась за transform и вызывала мерцание стопки. */
  var ICONS = {
    success: '<svg viewBox="0 0 24 24" stroke="currentColor"><path d="M4.5 12.5l5 5L19.5 7"/></svg>',
    error: '<svg viewBox="0 0 24 24" stroke="currentColor"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>',
    warning: '<svg viewBox="0 0 24 24" stroke="currentColor"><path d="M12 4 2.8 20h18.4L12 4z"/><path d="M12 10v4"/><path d="M12 17.2h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" stroke="currentColor"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5h.01"/></svg>'
  };
  var EASE_OUT = 'cubic-bezier(.21,1.02,.73,1)';
  var zone = null;

  function getZone() {
    if (!zone || !zone.isConnected) {
      zone = document.querySelector('.toast-zone') || document.createElement('div');
      zone.className = 'toast-zone';
      if (!zone.isConnected) document.body.append(zone);
    }
    return zone;
  }

  function withFlip(container, mutate) {
    var items = Array.prototype.slice.call(container.children);
    var first = new Map(items.map(function (el) { return [el, el.getBoundingClientRect().top]; }));
    mutate();
    items.forEach(function (el) {
      if (!el.isConnected) return;
      var dy = first.get(el) - el.getBoundingClientRect().top;
      if (dy) {
        el.animate(
          [{ transform: 'translate3d(0,' + dy + 'px,0)' }, { transform: 'translate3d(0,0,0)' }],
          { duration: 500, easing: EASE_OUT, composite: 'add' }
        );
      }
    });
  }

  function toast(message, type, opts) {
    if (!(type in ICONS)) type = 'info';
    var duration = (opts && opts.duration) || 3000;
    var z = getZone();

    var t = document.createElement('div');
    t.className = 'toast t-' + type;
    t.setAttribute('role', 'status');
    var ico = document.createElement('span');
    ico.className = 't-ico';
    ico.innerHTML = ICONS[type];
    var text = document.createElement('span');
    text.textContent = message;
    t.append(ico, text);

    withFlip(z, function () { z.append(t); });
    t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: 'ease-out' });
    t.animate(
      [{ transform: 'translate3d(0,10px,0)' }, { transform: 'translate3d(0,0,0)' }],
      { duration: 500, easing: EASE_OUT, composite: 'add' }
    );

    var dismissed = false;
    var timer = setTimeout(dismiss, duration);

    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(timer);
      /* fill:'forwards' держит тост прозрачным до удаления — без вспышки на последнем кадре */
      var exit = t.animate(
        [{ opacity: 1 }, { opacity: 0, transform: 'translate3d(0,6px,0)' }],
        { duration: 300, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }
      );
      exit.onfinish = function () { withFlip(z, function () { t.remove(); }); };
    }

    t.addEventListener('click', dismiss);
    return { dismiss: dismiss, element: t };
  }

  /* ===== Модальные окна ===== */
  function resolveEl(target) {
    return typeof target === 'string' ? document.querySelector(target) : target;
  }

  function openModal(target) {
    var el = resolveEl(target);
    if (el) el.classList.add('open');
  }

  function closeModal(target) {
    if (target) {
      var el = resolveEl(target);
      if (el) el.classList.remove('open');
      return;
    }
    document.querySelectorAll('.modal-backdrop.open').forEach(function (el) { el.classList.remove('open'); });
  }

  var modalEscBound = false;

  function initModals(root) {
    root = root || document;
    root.querySelectorAll('[data-modal-open]').forEach(function (btn) {
      btn.addEventListener('click', function () { openModal(btn.dataset.modalOpen); });
    });
    root.querySelectorAll('[data-modal-close]').forEach(function (btn) {
      btn.addEventListener('click', function () { closeModal(btn.closest('.modal-backdrop')); });
    });
    root.querySelectorAll('.modal-backdrop').forEach(function (bd) {
      bd.addEventListener('click', function (e) { if (e.target === bd) closeModal(bd); });
    });
    if (!modalEscBound) {
      modalEscBound = true;
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
    }
  }

  /* ===== Дропдауны ===== */
  function ddCloseAll(except) {
    document.querySelectorAll('.dropdown.open').forEach(function (d) {
      if (d !== except) {
        d.classList.remove('open');
        var t = d.querySelector('[data-dd-toggle]');
        if (t) t.setAttribute('aria-expanded', 'false');
      }
    });
  }

  var ddBound = false;

  function initDropdowns(root) {
    root = root || document;
    root.querySelectorAll('.dropdown').forEach(function (dd) {
      var toggle = dd.querySelector('[data-dd-toggle]');
      if (!toggle || toggle.dataset.wdsInit) return;
      toggle.dataset.wdsInit = '1';
      toggle.setAttribute('aria-haspopup', 'true');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var willOpen = !dd.classList.contains('open');
        ddCloseAll();
        dd.classList.toggle('open', willOpen);
        toggle.setAttribute('aria-expanded', String(willOpen));
      });
      dd.querySelectorAll('.dd-item').forEach(function (item) {
        item.addEventListener('click', function () {
          dd.classList.remove('open');
          toggle.setAttribute('aria-expanded', 'false');
        });
      });
    });
    if (!ddBound) {
      ddBound = true;
      document.addEventListener('click', function () { ddCloseAll(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') ddCloseAll(); });
    }
  }

  /* ===== Комбобоксы ===== */
  function csCloseAll(except) {
    document.querySelectorAll('.cselect.open').forEach(function (s) {
      if (s !== except) {
        s.classList.remove('open');
        var b = s.querySelector('.cselect-btn');
        if (b) b.setAttribute('aria-expanded', 'false');
      }
    });
  }

  var csBound = false;

  function initSelects(root) {
    root = root || document;
    root.querySelectorAll('.cselect').forEach(function (sel) {
      if (sel.dataset.wdsInit) return;
      sel.dataset.wdsInit = '1';

      var btn = sel.querySelector('.cselect-btn');
      var val = sel.querySelector('.cs-val');
      if (!btn || !val) return;

      var multi = sel.hasAttribute('data-multi');
      var placeholder = val.textContent;
      var countLabel = sel.dataset.countLabel || 'Выбрано:';
      var selected = new Set();
      var tagsBox = sel.dataset.tags
        ? document.querySelector(sel.dataset.tags)
        : (sel.parentElement ? sel.parentElement.querySelector('.cs-tags') : null);

      btn.setAttribute('aria-haspopup', 'listbox');
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var willOpen = !sel.classList.contains('open');
        csCloseAll(sel);
        sel.classList.toggle('open', willOpen);
        btn.setAttribute('aria-expanded', String(willOpen));
      });

      function optValue(opt) {
        return opt.dataset.val != null ? opt.dataset.val : opt.textContent.trim();
      }

      sel.querySelectorAll('.cs-opt').forEach(function (opt) {
        opt.addEventListener('click', function (e) {
          e.stopPropagation();
          var v = optValue(opt);
          if (multi) {
            selected.has(v) ? selected.delete(v) : selected.add(v);
            opt.classList.toggle('sel', selected.has(v));
            var box = opt.querySelector('.box');
            if (box) box.classList.toggle('on', selected.has(v));
            render();
          } else {
            sel.querySelectorAll('.cs-opt').forEach(function (o) { o.classList.remove('sel'); });
            opt.classList.add('sel');
            val.textContent = v;
            val.classList.remove('cs-ph');
            sel.classList.remove('open');
            btn.setAttribute('aria-expanded', 'false');
            sel.dispatchEvent(new CustomEvent('wds:change', { detail: { value: v } }));
          }
        });
      });

      function render() {
        if (tagsBox) {
          tagsBox.textContent = '';
          selected.forEach(function (v) {
            var tag = document.createElement('span');
            tag.className = 'cs-tag';
            var label = document.createElement('span');
            label.textContent = v;
            var x = document.createElement('button');
            x.type = 'button';
            x.setAttribute('aria-label', 'Убрать: ' + v);
            x.textContent = '✕';
            x.addEventListener('click', function () {
              selected.delete(v);
              sel.querySelectorAll('.cs-opt').forEach(function (o) {
                if (optValue(o) === v) {
                  o.classList.remove('sel');
                  var box = o.querySelector('.box');
                  if (box) box.classList.remove('on');
                }
              });
              render();
            });
            tag.append(label, x);
            tagsBox.append(tag);
          });
        }
        if (selected.size) {
          val.textContent = countLabel + ' ' + selected.size;
          val.classList.remove('cs-ph');
        } else {
          val.textContent = placeholder;
          val.classList.add('cs-ph');
        }
        sel.dispatchEvent(new CustomEvent('wds:change', { detail: { value: Array.from(selected) } }));
      }
    });

    if (!csBound) {
      csBound = true;
      document.addEventListener('click', function () { csCloseAll(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') csCloseAll(); });
    }
  }

  /* ===== Аккордеон ===== */
  function initAccordions(root) {
    root = root || document;
    root.querySelectorAll('.acc').forEach(function (acc) {
      acc.querySelectorAll('.acc-item').forEach(function (item) {
        var head = item.querySelector('.acc-head');
        var body = item.querySelector('.acc-body');
        if (!head || !body || head.dataset.wdsInit) return;
        head.dataset.wdsInit = '1';

        var isOpen = item.classList.contains('open');
        if (isOpen) body.style.maxHeight = body.scrollHeight + 'px';
        head.setAttribute('aria-expanded', String(isOpen));

        head.addEventListener('click', function () {
          var wasOpen = item.classList.contains('open');
          acc.querySelectorAll('.acc-item').forEach(function (x) {
            x.classList.remove('open');
            var b = x.querySelector('.acc-body');
            if (b) b.style.maxHeight = '';
            var h = x.querySelector('.acc-head');
            if (h) h.setAttribute('aria-expanded', 'false');
          });
          if (!wasOpen) {
            item.classList.add('open');
            body.style.maxHeight = body.scrollHeight + 'px';
            head.setAttribute('aria-expanded', 'true');
          }
        });
      });
    });
  }

  /* ===== Табы ===== */
  function initTabs(root) {
    root = root || document;
    root.querySelectorAll('.tabs,.tabs-underline').forEach(function (group) {
      if (group.dataset.wdsInit) return;
      group.dataset.wdsInit = '1';
      group.addEventListener('click', function (e) {
        var btn = e.target.closest('.tab');
        if (!btn || !group.contains(btn)) return;
        group.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x === btn); });
      });
    });
  }

  /* ===== Слайдеры ===== */
  function initRanges(root) {
    root = root || document;
    root.querySelectorAll('input[type=range]').forEach(function (r) {
      if (r.dataset.wdsInit) return;
      r.dataset.wdsInit = '1';
      var update = function () {
        var min = Number(r.min) || 0;
        var max = Number(r.max) || 100;
        var pct = ((r.value - min) / (max - min)) * 100;
        r.style.setProperty('--val', pct + '%');
      };
      r.addEventListener('input', update);
      update();
    });
  }

  /* ===== Появление при скролле ===== */
  function initReveal(root) {
    root = root || document;
    var els = root.querySelectorAll('.reveal:not(.in)');
    if (!els.length) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.08 });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ===== Свечение карточек ===== */
  function initHoverCards(root) {
    root = root || document;
    root.querySelectorAll('.hover-card').forEach(function (c) {
      if (c.dataset.wdsInit) return;
      c.dataset.wdsInit = '1';
      c.addEventListener('mousemove', function (e) {
        var r = c.getBoundingClientRect();
        c.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        c.style.setProperty('--my', (e.clientY - r.top) + 'px');
      });
    });
  }

  /* ===== Публичный API ===== */
  function init(root) {
    initModals(root);
    initDropdowns(root);
    initSelects(root);
    initAccordions(root);
    initTabs(root);
    initRanges(root);
    initReveal(root);
    initHoverCards(root);
  }

  window.Whitely = {
    init: init,
    toast: toast,
    openModal: openModal,
    closeModal: closeModal,
    initModals: initModals,
    initDropdowns: initDropdowns,
    initSelects: initSelects,
    initAccordions: initAccordions,
    initTabs: initTabs,
    initRanges: initRanges,
    initReveal: initReveal,
    initHoverCards: initHoverCards
  };
})();
