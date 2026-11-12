/** Searchable command list for the studio's existing native dialog.
 * Commands remain supplied by the owner so availability follows current state.
 */
export function mountCommandPalette({ getCommands }) {
  if (typeof getCommands !== 'function') throw new TypeError('getCommands must return studio commands.');
  const dialog = document.getElementById('command-dialog');
  const query = document.getElementById('command-query');
  const results = document.getElementById('command-results');
  if (!dialog || !query || !results) throw new Error('명령 검색 화면을 찾지 못했습니다.');

  let matching = [], activeIndex = -1, disposed = false;
  const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('ko-KR');
  const getAvailable = () => {
    const commands = getCommands();
    if (!Array.isArray(commands)) return [];
    const ids = new Set();
    return commands.filter(command => {
      if (!command || typeof command.id !== 'string' || !command.id || ids.has(command.id) ||
          typeof command.label !== 'string' || typeof command.run !== 'function') return false;
      ids.add(command.id); return true;
    });
  };
  query.setAttribute('role', 'combobox');
  query.setAttribute('aria-autocomplete', 'list');
  query.setAttribute('aria-controls', results.id);
  query.setAttribute('aria-expanded', 'false');
  results.setAttribute('role', 'listbox');
  results.setAttribute('aria-label', '검색된 명령');

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };
  function setActive(index, scroll = true) {
    activeIndex = matching.length ? (index + matching.length) % matching.length : -1;
    for (const option of results.querySelectorAll('[data-command-index]')) {
      const selected = Number(option.dataset.commandIndex) === activeIndex;
      option.classList.toggle('active', selected);
      option.setAttribute('aria-selected', String(selected));
    }
    if (activeIndex < 0) { query.removeAttribute('aria-activedescendant'); return; }
    const option = results.querySelector(`[data-command-index="${activeIndex}"]`);
    if (option) {
      query.setAttribute('aria-activedescendant', option.id);
      if (scroll) option.scrollIntoView({ block: 'nearest' });
    }
  }
  function render() {
    const terms = normalize(query.value).trim().split(/\s+/).filter(Boolean);
    matching = getAvailable().filter(command => {
      const haystack = normalize(`${command.label} ${command.detail ?? ''} ${command.shortcut ?? ''}`);
      return terms.every(term => haystack.includes(term));
    });
    results.replaceChildren();
    matching.forEach((command, index) => {
      const option = node('div', 'command-option'); option.id = `studio-command-option-${index}`;
      option.dataset.commandIndex = String(index); option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
      const copy = node('span', 'command-copy'); copy.append(node('strong', 'command-label', command.label));
      if (command.detail) copy.append(node('span', 'command-detail', command.detail));
      option.append(copy);
      if (command.shortcut) option.append(node('kbd', 'command-shortcut', command.shortcut));
      results.append(option);
    });
    if (!matching.length) {
      const empty = node('div', 'command-empty', '일치하는 명령이 없습니다. 다른 단어로 검색해 주세요.');
      empty.setAttribute('role', 'option'); empty.setAttribute('aria-disabled', 'true'); results.append(empty);
    }
    setActive(matching.length ? 0 : -1, false);
  }
  function close() {
    if (dialog.open) dialog.close();
    query.setAttribute('aria-expanded', 'false'); query.removeAttribute('aria-activedescendant');
  }
  function open() {
    if (disposed) return;
    query.value = ''; render();
    if (!dialog.open) dialog.showModal();
    query.setAttribute('aria-expanded', 'true'); query.focus();
  }
  async function invoke(index) {
    const candidate = matching[index]; if (!candidate) return;
    // Do not run a command removed by a state change since the list was shown.
    const command = getAvailable().find(item => item.id === candidate.id);
    if (!command) { render(); return; }
    close();
    try { await command.run(); }
    catch (error) {
      if (disposed) return;
      open();
      const message = node('div', 'command-empty', error?.message || '명령을 실행하지 못했습니다. 다시 확인해 주세요.');
      message.setAttribute('role', 'option'); message.setAttribute('aria-disabled', 'true');
      matching = []; results.replaceChildren(message); setActive(-1);
    }
  }
  function onInput() { render(); }
  function onKey(event) {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      if (matching.length) setActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); if (activeIndex >= 0) void invoke(activeIndex);
    } else if (event.key === 'Escape') {
      // Preserve the native dialog cancel/close behavior, but don't also trigger
      // unrelated editor Escape shortcuts in the same keystroke.
      event.stopPropagation();
    }
  }
  function onClick(event) {
    const option = event.target.closest('[data-command-index]');
    if (!option || !results.contains(option)) return;
    void invoke(Number(option.dataset.commandIndex));
  }
  function onPointerDown(event) {
    if (event.target.closest('[data-command-index]')) event.preventDefault();
  }
  function onClose() {
    if (dialog.open) return;
    query.setAttribute('aria-expanded', 'false'); query.removeAttribute('aria-activedescendant');
    // Native dialog.close() restores focus before a command runs. Reapplying
    // focus in this queued event would steal focus from a command's target.
  }
  query.addEventListener('input', onInput); query.addEventListener('keydown', onKey);
  results.addEventListener('click', onClick); results.addEventListener('pointerdown', onPointerDown);
  dialog.addEventListener('close', onClose);
  return { open, close, destroy() {
    disposed = true; close();
    query.removeEventListener('input', onInput); query.removeEventListener('keydown', onKey);
    results.removeEventListener('click', onClick); results.removeEventListener('pointerdown', onPointerDown);
    dialog.removeEventListener('close', onClose);
  } };
}
