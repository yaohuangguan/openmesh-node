import './docs.css';

const copyText = async (value: string, button: HTMLButtonElement) => {
  try {
    await navigator.clipboard.writeText(value);
    const previous = button.textContent;
    button.textContent = 'copied';
    window.setTimeout(() => { button.textContent = previous; }, 1100);
  } catch {
    button.textContent = 'select + copy';
  }
};

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.addEventListener('click', () => {
    const value = button.dataset.copy;
    if (value) void copyText(value, button);
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-target]')) {
  button.addEventListener('click', () => {
    const selector = button.dataset.copyTarget;
    const target = selector ? document.querySelector<HTMLElement>(selector) : null;
    const value = target?.textContent?.trim();
    if (value) void copyText(value, button);
  });
}

const localNav = Array.from(document.querySelectorAll<HTMLAnchorElement>('.docs-sidebar a[href^="#"]'));
const sections = localNav
  .map(link => {
    const href = link.getAttribute('href');
    const section = href ? document.querySelector<HTMLElement>(href) : null;
    return section ? { link, section } : null;
  })
  .filter((item): item is { link: HTMLAnchorElement; section: HTMLElement } => Boolean(item));

const updateActive = () => {
  const offset = window.scrollY + 150;
  let current = sections[0];
  for (const item of sections) {
    if (item.section.offsetTop <= offset) current = item;
  }
  for (const item of sections) item.link.classList.toggle('active', item === current);
};

window.addEventListener('scroll', updateActive, { passive: true });
updateActive();
