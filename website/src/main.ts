import './styles.css';

const copyButtons = document.querySelectorAll<HTMLButtonElement>('[data-copy]');

for (const button of copyButtons) {
  button.addEventListener('click', async () => {
    const value = button.dataset.copy;
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      const previous = button.textContent;
      button.textContent = 'Copied';
      button.classList.add('copied');
      window.setTimeout(() => {
        button.textContent = previous;
        button.classList.remove('copied');
      }, 1400);
    } catch {
      button.textContent = 'Select & copy';
    }
  });
}

const header = document.querySelector<HTMLElement>('.site-header');

const updateHeader = () => {
  header?.classList.toggle('scrolled', window.scrollY > 12);
};

updateHeader();
window.addEventListener('scroll', updateHeader, { passive: true });
