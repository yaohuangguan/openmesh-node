import './styles.css';

type CodeExample = {
  filename: string;
  html: string;
  plain: string;
  title: string;
  note: string;
};

const examples: Record<string, CodeExample> = {
  http: {
    filename: 'server.ts',
    plain: `import openmesh from 'openmesh-node';
import { bodyParser } from 'openmesh-node/plugins';

const app = openmesh();
app.use(bodyParser());

app.get('/users/:id', ({ params }) => ({
  id: params.id
}));

await app.listen({ port: 3000 });`,
    html: `<span class="kw">import</span> openmesh <span class="kw">from</span> <span class="str">'openmesh-node'</span>;
<span class="kw">import</span> { bodyParser } <span class="kw">from</span> <span class="str">'openmesh-node/plugins'</span>;

<span class="kw">const</span> app = <span class="fn">openmesh</span>();
app.<span class="fn">use</span>(<span class="fn">bodyParser</span>());

app.<span class="fn">get</span>(<span class="str">'/users/:id'</span>, ({ params }) =&gt; ({
  id: params.id
}));

<span class="kw">await</span> app.<span class="fn">listen</span>({ port: <span class="num">3000</span> });`,
    title: 'Native request path',
    note: 'Router → middleware → handler → response stays inside the Node.js runtime.'
  },
  mesh: {
    filename: 'gateway.ts',
    plain: `import openmesh from 'openmesh-node';

const app = openmesh({
  service: 'gateway',
  mesh: {
    control: {
      url: process.env.OPENMESH_CONTROL_URL!,
      token: process.env.OPENMESH_TOKEN!
    }
  }
});

const payments = app.mesh('payments');

const charge = await payments.post('/charges', {
  key: user.id,
  body: { userId: user.id, amount: order.total }
});`,
    html: `<span class="kw">import</span> openmesh <span class="kw">from</span> <span class="str">'openmesh-node'</span>;

<span class="kw">const</span> app = <span class="fn">openmesh</span>({
  service: <span class="str">'gateway'</span>,
  mesh: {
    control: {
      url: process.env.OPENMESH_CONTROL_URL!,
      token: process.env.OPENMESH_TOKEN!
    }
  }
});

<span class="kw">const</span> payments = app.<span class="fn">mesh</span>(<span class="str">'payments'</span>);

<span class="kw">const</span> charge = <span class="kw">await</span> payments.<span class="fn">post</span>(<span class="str">'/charges'</span>, {
  key: user.id,
  body: { userId: user.id, amount: order.total }
});`,
    title: 'Application-native service mesh',
    note: 'The service handle reuses discovery, traffic policy, pressure state, retries, circuits, identity and transport resources.'
  },
  services: {
    filename: 'control.ts',
    plain: `import openmesh from 'openmesh-node';
import { controlPlane } from 'openmesh-node/services';

const control = openmesh();

control.register(controlPlane({
  token: process.env.OPENMESH_TOKEN!,
  // Redis adapters can replace the in-memory defaults.
}));

await control.listen({ port: 4000 });`,
    html: `<span class="kw">import</span> openmesh <span class="kw">from</span> <span class="str">'openmesh-node'</span>;
<span class="kw">import</span> { controlPlane } <span class="kw">from</span> <span class="str">'openmesh-node/services'</span>;

<span class="kw">const</span> control = <span class="fn">openmesh</span>();

control.<span class="fn">register</span>(<span class="fn">controlPlane</span>({
  token: process.env.OPENMESH_TOKEN!,
  <span class="muted">// Redis adapters can replace the in-memory defaults.</span>
}));

<span class="kw">await</span> control.<span class="fn">listen</span>({ port: <span class="num">4000</span> });`,
    title: 'Versioned discovery and configuration',
    note: 'Registration leases, membership revisions and push-first watches turn topology and config into explicit runtime state.'
  }
};

const codeContent = document.querySelector<HTMLElement>('#code-content');
const codeFilename = document.querySelector<HTMLElement>('#code-filename');
const codeNoteTitle = document.querySelector<HTMLElement>('#code-note-title');
const codeNoteCopy = document.querySelector<HTMLElement>('#code-note-copy');

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-example]')) {
  button.addEventListener('click', () => {
    const key = button.dataset.example;
    if (!key || !(key in examples)) return;

    const example = examples[key];
    if (!example) return;

    for (const sibling of document.querySelectorAll<HTMLButtonElement>('[data-example]')) {
      sibling.classList.toggle('active', sibling === button);
    }

    if (codeContent) {
      codeContent.innerHTML = example.html;
      codeContent.dataset.plain = example.plain;
    }
    if (codeFilename) codeFilename.textContent = example.filename;
    if (codeNoteTitle) codeNoteTitle.textContent = example.title;
    if (codeNoteCopy) codeNoteCopy.textContent = example.note;
  });
}

const installCode = document.querySelector<HTMLElement>('#install-command');

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]')) {
  button.addEventListener('click', () => {
    const command = button.dataset.command;
    if (!command || !installCode) return;

    for (const sibling of document.querySelectorAll<HTMLButtonElement>('[data-command]')) {
      sibling.classList.toggle('active', sibling === button);
    }

    installCode.textContent = command;
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-target]')) {
  button.addEventListener('click', async () => {
    const selector = button.dataset.copyTarget;
    if (!selector) return;

    const target = document.querySelector<HTMLElement>(selector);
    if (!target) return;

    const value = target.dataset.plain ?? target.textContent ?? '';
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      const previous = button.textContent;
      button.textContent = 'Copied';
      button.classList.add('copied');

      window.setTimeout(() => {
        button.textContent = previous;
        button.classList.remove('copied');
      }, 1200);
    } catch {
      button.textContent = 'Select + copy';
    }
  });
}

if (codeContent) {
  codeContent.dataset.plain = examples.http.plain;
}
