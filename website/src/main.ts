[Reading 34 lines from start (total: 34 lines, 873 B)]

import './styles.css';

const copyButtons = document.querySelectorAll<HTMLButtonElement>('[data-copy]');

for (const button of copyButtons) {
  button.addEventListener('click', async () => {
    const value = button.dataset.copy;
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      const previous = button.textContent;
      button.textContent = 'copied';
      button.classList.add('copied');

      window.setTimeout(() => {
        button.textContent = previous;
        button.classList.remove('copied');
      }, 1300);
    } catch {
      button.textContent = 'select + copy';
    }
  });
}

const topbar = document.querySelector<HTMLElement>('.topbar');

const syncHeader = () => {
  topbar?.classList.toggle('scrolled', window.scrollY > 18);
};

syncHeader();
window.addEventListener('scroll', syncHeader, { passive: true });