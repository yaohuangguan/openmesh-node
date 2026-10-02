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

const sectionLinks = new Map<string, HTMLAnchorElement>();
for (const link of document.querySelectorAll<HTMLAnchorElement>('.nav a[href^="#"]')) {
  const id = link.getAttribute('href')?.slice(1);
  if (id) sectionLinks.set(id, link);
}

const observedSections = [...sectionLinks.keys()]
  .map(id => document.getElementById(id))
  .filter((section): section is HTMLElement => section !== null);

if (observedSections.length > 0 && 'IntersectionObserver' in window) {
  const visible = new Map<string, number>();

  const updateActiveLink = () => {
    const candidate = [...visible.entries()]
      .filter(([, ratio]) => ratio > 0)
      .sort((a, b) => b[1] - a[1])[0]?.[0];

    for (const [id, link] of sectionLinks) {
      link.classList.toggle('active', id === candidate);
    }
  };

  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        visible.set(entry.target.id, entry.intersectionRatio);
      }
      updateActiveLink();
    },
    {
      rootMargin: '-18% 0px -55% 0px',
      threshold: [0, 0.1, 0.25, 0.5, 0.75, 1]
    }
  );

  for (const section of observedSections) observer.observe(section);
}