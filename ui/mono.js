(function () {
  'use strict';

  var dropdownsBound = false;
  var toastZone;

  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'm-icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function closeDropdowns(except) {
    document.querySelectorAll('[data-dropdown].is-open').forEach(function (dropdown) {
      if (dropdown === except) return;
      dropdown.classList.remove('is-open');
      var trigger = dropdown.querySelector('[aria-haspopup="menu"]');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function initDropdowns(root) {
    root.querySelectorAll('[data-dropdown]').forEach(function (dropdown) {
      if (dropdown.dataset.monoReady) return;
      dropdown.dataset.monoReady = 'true';
      var trigger = dropdown.querySelector('[aria-haspopup="menu"]');
      var items = Array.from(dropdown.querySelectorAll('[role="menuitem"]'));
      if (!trigger || !items.length) return;
      items.forEach(function (item) { item.tabIndex = -1; });

      function open(focusItem) {
        closeDropdowns(dropdown);
        dropdown.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
        if (focusItem) items[0].focus();
      }

      function close(restoreFocus) {
        dropdown.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) trigger.focus();
      }

      trigger.addEventListener('click', function () {
        dropdown.classList.contains('is-open') ? close(false) : open(false);
      });
      trigger.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          open(false);
          (event.key === 'ArrowDown' ? items[0] : items[items.length - 1]).focus();
        }
      });
      dropdown.addEventListener('keydown', function (event) {
        var index = items.indexOf(document.activeElement);
        if (event.key === 'Escape') {
          event.preventDefault();
          close(true);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          var direction = event.key === 'ArrowDown' ? 1 : -1;
          items[(index + direction + items.length) % items.length].focus();
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          (event.key === 'Home' ? items[0] : items[items.length - 1]).focus();
        }
      });
      items.forEach(function (item) {
        item.addEventListener('click', function () {
          close(false);
          dropdown.dispatchEvent(new CustomEvent('mono:select', { detail: { value: item.textContent.trim() } }));
        });
      });
    });

    if (!dropdownsBound) {
      dropdownsBound = true;
      document.addEventListener('click', function (event) {
        if (!event.target.closest('[data-dropdown]')) closeDropdowns();
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeDropdowns();
      });
    }
  }

  function initTabs(root) {
    root.querySelectorAll('[role="tablist"]').forEach(function (list) {
      if (list.dataset.monoReady) return;
      list.dataset.monoReady = 'true';
      var tabs = Array.from(list.querySelectorAll('[role="tab"]'));
      if (!tabs.length) return;

      function activate(tab, focus) {
        tabs.forEach(function (item) {
          var selected = item === tab;
          item.classList.toggle('is-active', selected);
          item.setAttribute('aria-selected', String(selected));
          item.tabIndex = selected ? 0 : -1;
          var panel = document.getElementById(item.getAttribute('aria-controls'));
          if (panel) panel.hidden = !selected;
        });
        if (focus) tab.focus();
        list.dispatchEvent(new CustomEvent('mono:tabchange', { detail: { tab: tab.id } }));
      }

      tabs.forEach(function (tab, index) {
        tab.addEventListener('click', function () { activate(tab, false); });
        tab.addEventListener('keydown', function (event) {
          var next;
          if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
          if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = tabs.length - 1;
          if (next !== undefined) {
            event.preventDefault();
            activate(tabs[next], true);
          }
        });
      });
    });
  }

  function initSegmented(root) {
    root.querySelectorAll('[data-segmented]').forEach(function (group) {
      if (group.dataset.monoReady) return;
      group.dataset.monoReady = 'true';
      var buttons = Array.from(group.querySelectorAll('button'));
      buttons.forEach(function (button) {
        if (!button.hasAttribute('aria-pressed')) button.setAttribute('aria-pressed', String(button.classList.contains('is-active')));
        button.addEventListener('click', function () {
          buttons.forEach(function (item) {
            var selected = item === button;
            item.classList.toggle('is-active', selected);
            item.setAttribute('aria-pressed', String(selected));
          });
          group.dispatchEvent(new CustomEvent('mono:change', { detail: { value: button.textContent.trim() } }));
        });
      });
    });
  }

  function initRanges(root) {
    root.querySelectorAll('input[type="range"]').forEach(function (range) {
      if (range.dataset.monoReady) return;
      range.dataset.monoReady = 'true';
      function update() {
        var min = Number(range.min || 0);
        var max = Number(range.max || 100);
        var value = Number(range.value);
        var percentage = max === min ? 0 : ((value - min) / (max - min)) * 100;
        range.style.setProperty('--m-range-value', percentage + '%');
        if (range.dataset.rangeOutput) {
          var output = document.getElementById(range.dataset.rangeOutput);
          if (output) output.textContent = range.value + '%';
        }
      }
      range.addEventListener('input', update);
      update();
    });
  }

  function animateDetails(details, closing) {
    var summary = details.querySelector('summary');
    var startHeight = details.getBoundingClientRect().height;
    if (details._monoAnimation) details._monoAnimation.cancel();
    details.style.height = '';
    details.style.overflow = '';
    if (!closing) details.open = true;
    var endHeight = closing ? summary.getBoundingClientRect().height : details.getBoundingClientRect().height;
    summary.setAttribute('aria-expanded', String(!closing));
    details.style.overflow = 'hidden';
    details.style.height = startHeight + 'px';
    details._monoClosing = closing;
    if (!details.animate) {
      details.open = !closing;
      details.style.height = '';
      details.style.overflow = '';
      return;
    }
    details._monoAnimation = details.animate([
      { height: startHeight + 'px' },
      { height: endHeight + 'px' }
    ], { duration: closing ? 260 : 320, easing: toastEase });
    details._monoAnimation.onfinish = function () {
      if (closing) details.open = false;
      details.style.height = '';
      details.style.overflow = '';
      details._monoAnimation = null;
    };
  }

  function initAccordions(root) {
    root.querySelectorAll('details.m-details').forEach(function (details) {
      if (details.dataset.monoReady) return;
      details.dataset.monoReady = 'true';
      var summary = details.querySelector('summary');
      if (!summary) return;
      summary.setAttribute('aria-expanded', String(details.open));
      summary.addEventListener('click', function (event) {
        event.preventDefault();
        var closing = details._monoAnimation ? details._monoClosing : details.open;
        if (!closing && !details.hasAttribute('data-effect')) {
          details.parentElement.querySelectorAll(':scope > details.m-details').forEach(function (sibling) {
            if (sibling === details) return;
            var siblingClosing = sibling._monoAnimation ? sibling._monoClosing : !sibling.open;
            if (!siblingClosing) animateDetails(sibling, true);
          });
        }
        animateDetails(details, closing);
      });
    });
  }

  var comboboxesBound = false;

  function closeComboboxes(except) {
    document.querySelectorAll('[data-combobox].is-open').forEach(function (combo) {
      if (combo === except) return;
      combo.classList.remove('is-open');
      var trigger = combo.querySelector('.m-combobox-trigger');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function initComboboxes(root) {
    root.querySelectorAll('[data-combobox]').forEach(function (combo) {
      if (combo.dataset.monoReady) return;
      combo.dataset.monoReady = 'true';
      var trigger = combo.querySelector('.m-combobox-trigger');
      var listbox = combo.querySelector('[role="listbox"]');
      var value = combo.querySelector('.m-combobox-value');
      var options = Array.from(combo.querySelectorAll('[role="option"]'));
      if (!trigger || !listbox || !value || !options.length) return;
      var multiple = combo.hasAttribute('data-multiple');
      var tags = combo.parentElement ? combo.parentElement.querySelector('[data-combobox-tags]') : null;
      var typeahead = '';
      var typeaheadTimer;
      options.forEach(function (option) { option.tabIndex = -1; });

      function selectedOptions() {
        return options.filter(function (option) { return option.getAttribute('aria-selected') === 'true'; });
      }

      function render() {
        var selected = selectedOptions();
        if (multiple) {
          value.textContent = selected.length ? 'Выбрано: ' + selected.length : (combo.dataset.placeholder || 'Выбрать');
          value.classList.toggle('is-placeholder', !selected.length);
        } else {
          value.textContent = selected.length ? selected[0].textContent.trim() : (combo.dataset.placeholder || 'Выбрать');
          value.classList.toggle('is-placeholder', !selected.length);
        }
        if (tags) {
          tags.textContent = '';
          if (multiple) selected.forEach(function (option) {
            var tag = document.createElement('span');
            tag.className = 'm-combobox-tag';
            var label = document.createElement('span');
            label.textContent = option.textContent.trim();
            var remove = document.createElement('button');
            remove.type = 'button';
            remove.setAttribute('aria-label', 'Убрать: ' + option.textContent.trim());
            remove.appendChild(icon('x'));
            remove.addEventListener('click', function () {
              option.setAttribute('aria-selected', 'false');
              render();
              emitChange();
            });
            tag.append(label, remove);
            tags.appendChild(tag);
          });
          tags.hidden = !selected.length;
        }
      }

      function emitChange() {
        var selected = selectedOptions();
        combo.dispatchEvent(new CustomEvent('mono:change', { detail: { value: multiple ? selected.map(function (option) { return option.textContent.trim(); }) : (selected[0] ? selected[0].textContent.trim() : null) } }));
      }

      function open(last) {
        closeComboboxes(combo);
        combo.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
        var target = last ? options[options.length - 1] : (selectedOptions()[0] || options[0]);
        target.focus();
      }

      function close(restoreFocus) {
        combo.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) trigger.focus();
      }

      trigger.addEventListener('click', function () {
        combo.classList.contains('is-open') ? close(false) : open(false);
      });
      trigger.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          open(event.key === 'ArrowUp');
        }
      });
      options.forEach(function (option, index) {
        option.addEventListener('click', function () {
          if (multiple) {
            option.setAttribute('aria-selected', String(option.getAttribute('aria-selected') !== 'true'));
          } else {
            options.forEach(function (item) { item.setAttribute('aria-selected', String(item === option)); });
            close(true);
          }
          render();
          emitChange();
        });
        option.addEventListener('keydown', function (event) {
          var next;
          if (event.key === 'ArrowDown') next = (index + 1) % options.length;
          if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = options.length - 1;
          if (next !== undefined) {
            event.preventDefault();
            options[next].focus();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            close(true);
          } else if (event.key === 'Tab') {
            close(false);
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            clearTimeout(typeaheadTimer);
            typeahead += event.key.toLocaleLowerCase();
            var match = options.find(function (item) { return item.textContent.trim().toLocaleLowerCase().startsWith(typeahead); });
            if (match) match.focus();
            typeaheadTimer = setTimeout(function () { typeahead = ''; }, 600);
          }
        });
      });
      render();
    });

    if (!comboboxesBound) {
      comboboxesBound = true;
      document.addEventListener('click', function (event) {
        if (!event.target.closest('[data-combobox]')) closeComboboxes();
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeComboboxes();
      });
    }
  }

  function initDialogs(root) {
    root.querySelectorAll('[data-dialog-open]').forEach(function (trigger) {
      if (trigger.dataset.monoReady) return;
      trigger.dataset.monoReady = 'true';
      trigger.addEventListener('click', function () {
        var dialog = document.getElementById(trigger.dataset.dialogOpen);
        if (!dialog) return;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      });
    });
    root.querySelectorAll('dialog.m-dialog').forEach(function (dialog) {
      if (dialog.dataset.monoReady) return;
      dialog.dataset.monoReady = 'true';
      dialog.addEventListener('click', function (event) {
        if (event.target !== dialog) return;
        var rect = dialog.getBoundingClientRect();
        var inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (!inside) dialog.close('cancel');
      });
      dialog.addEventListener('close', function () {
        dialog.dispatchEvent(new CustomEvent('mono:dialogclose', { detail: { result: dialog.returnValue } }));
      });
    });
  }

  function initPagination(root) {
    root.querySelectorAll('.m-pagination').forEach(function (pagination) {
      if (pagination.dataset.monoReady) return;
      pagination.dataset.monoReady = 'true';
      var pages = Array.from(pagination.querySelectorAll('.m-page'));
      var buttons = Array.from(pagination.querySelectorAll('.m-btn'));
      function selectPage(page) {
        pages.forEach(function (item) {
          var selected = item === page;
          item.classList.toggle('is-active', selected);
          if (selected) item.setAttribute('aria-current', 'page');
          else item.removeAttribute('aria-current');
        });
        if (buttons[0]) buttons[0].disabled = pages.indexOf(page) === 0;
        if (buttons[1]) buttons[1].disabled = pages.indexOf(page) === pages.length - 1;
      }
      pages.forEach(function (page) { page.addEventListener('click', function () { selectPage(page); }); });
      buttons.forEach(function (button, index) {
        button.addEventListener('click', function () {
          var current = pages.findIndex(function (page) { return page.classList.contains('is-active'); });
          var next = index === 0 ? current - 1 : current + 1;
          if (pages[next]) selectPage(pages[next]);
        });
      });
    });
  }

  var toastQueue = [];
  var toastLimit = 4;
  var toastEase = 'cubic-bezier(.16,1,.3,1)';

  function getToastZone() {
    if (toastZone && toastZone.isConnected) return toastZone;
    toastZone = document.querySelector('.m-toast-zone');
    if (!toastZone) {
      toastZone = document.createElement('div');
      toastZone.className = 'm-toast-zone';
      toastZone.setAttribute('aria-live', 'polite');
      toastZone.setAttribute('aria-label', 'Уведомления');
      document.body.appendChild(toastZone);
    }
    return toastZone;
  }

  function shiftToasts(zone, mutate) {
    var shells = Array.from(zone.children);
    var positions = new Map(shells.map(function (shell) { return [shell, shell.getBoundingClientRect().top]; }));
    shells.forEach(function (shell) { if (shell._monoFlip) shell._monoFlip.cancel(); });
    mutate();
    shells.forEach(function (shell) {
      if (!shell.isConnected) return;
      var delta = positions.get(shell) - shell.getBoundingClientRect().top;
      if (!delta || !shell.animate) return;
      shell._monoFlip = shell.animate([
        { transform: 'translate3d(0,' + delta + 'px,0)' },
        { transform: 'translate3d(0,0,0)' }
      ], { duration: 500, easing: toastEase });
    });
  }

  function toast(message, options) {
    options = typeof options === 'string' ? { type: options } : (options || {});
    var type = options.type || 'info';
    var duration = options.duration === undefined ? 5000 : options.duration;
    var shell = document.createElement('div');
    shell.className = 'm-toast-item';
    var item = document.createElement('div');
    item.className = 'm-toast';
    item.setAttribute('role', type === 'error' ? 'alert' : 'status');
    item.appendChild(icon(type === 'error' ? 'error' : type === 'success' ? 'success' : 'info'));
    var text = document.createElement('p');
    text.textContent = String(message);
    var closeButton = document.createElement('button');
    closeButton.className = 'm-icon-button';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Закрыть уведомление');
    closeButton.appendChild(icon('x'));
    item.append(text, closeButton);
    shell.appendChild(item);

    var timer = null;
    var remaining = duration;
    var started = 0;
    var dismissed = false;
    var enterAnimation;
    var record = { element: item, dismiss: dismiss };

    function show() {
      var zone = getToastZone();
      shiftToasts(zone, function () { zone.appendChild(shell); });
      if (item.animate) {
        enterAnimation = item.animate([
          { opacity: 0, transform: 'translate3d(0,12px,0)' },
          { opacity: 1, transform: 'translate3d(0,0,0)' }
        ], { duration: 480, easing: toastEase, fill: 'backwards' });
      }
      start();
    }

    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(timer);
      timer = null;
      var queuedIndex = toastQueue.indexOf(record);
      if (queuedIndex !== -1) {
        toastQueue.splice(queuedIndex, 1);
        return;
      }
      if (!shell.isConnected) return;
      if (enterAnimation) enterAnimation.cancel();
      var exit = item.animate ? item.animate([
        { opacity: 1, transform: 'translate3d(0,0,0)' },
        { opacity: 0, transform: 'translate3d(0,8px,0)' }
      ], { duration: 280, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }) : null;
      function remove() {
        var zone = getToastZone();
        shiftToasts(zone, function () { shell.remove(); });
        var next = toastQueue.shift();
        if (next) next.show();
      }
      if (exit) exit.onfinish = remove;
      else remove();
    }

    function start() {
      if (duration <= 0 || dismissed || timer !== null || !shell.isConnected) return;
      started = performance.now();
      timer = setTimeout(dismiss, remaining);
    }
    function pause() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(100, remaining - (performance.now() - started));
    }
    item.addEventListener('mouseenter', pause);
    item.addEventListener('mouseleave', start);
    item.addEventListener('focusin', pause);
    item.addEventListener('focusout', function (event) {
      if (!item.contains(event.relatedTarget)) start();
    });
    closeButton.addEventListener('click', dismiss);

    record.show = show;
    if (getToastZone().children.length >= toastLimit) toastQueue.push(record);
    else show();
    return record;
  }

  function init(root) {
    root = root || document;
    initDropdowns(root);
    initTabs(root);
    initSegmented(root);
    initRanges(root);
    initComboboxes(root);
    initAccordions(root);
    initDialogs(root);
    initPagination(root);
  }

  window.Mono = {
    init: init,
    toast: toast,
    initDropdowns: initDropdowns,
    initTabs: initTabs,
    initSegmented: initSegmented,
    initRanges: initRanges,
    initComboboxes: initComboboxes,
    initAccordions: initAccordions,
    initDialogs: initDialogs,
    initPagination: initPagination
  };
}());
