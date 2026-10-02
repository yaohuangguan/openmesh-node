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
import { jsonBody } from 'openmesh-node/plugins';

const app = openmesh();
app.use(jsonBody());

app.get('/users/:id', ctx => ({
  id: ctx.params.id
}));

await app.listen({ port: 3000 });`,
    html: `<span class="kw">import</span> openmesh <span class="kw">from</span> <span class="str">'openmesh-node'</span>;
<span class="kw">import</span> { jsonBody } <span class="kw">from</span> <span class="str">'openmesh-node/plugins'</span>;

<span class="kw">const</span> app = <span class="fn">openmesh</span>();
app.<span class="fn">use</span>(<span class="fn">jsonBody</span>());

app.<span class="fn">get</span>(<span class="str">'/users/:id'</span>, ctx =&gt; ({
  id: ctx.params.id
}));

<span class="kw">await</span> app.<span class="fn">listen</span>({ port: <span class="num">3000</span> });`,
    title: 'Native request path',
    note: 'Router → middleware → handler → response stays inside the Node.js runtime.'
  },
  mesh: {
    filename: 'gateway.ts',
    plain: `import { PeerPool } from 'openmesh-node/mesh';

const pool = new PeerPool({
  peers: [
    'http://users-a:3000',
    'http://users-b:3000'
  ]
});

const response = await pool.request('/users/42', {
  key: '42',
  timeout: 1500
});

console.log(await response.json());`,
    html: `<span class="kw">import</span> { PeerPool } <span class="kw">from</span> <span class="str">'openmesh-node/mesh'</span>;

<span class="kw">const</span> pool = <span class="kw">new</span> <span class="fn">PeerPool</span>({
  peers: [
    <span class="str">'http://users-a:3000'</span>,
    <span class="str">'http://users-b:3000'</span>
  ]
});

<span class="kw">const</span> response = <span class="kw">await</span> pool.<span class="fn">request</span>(<span class="str">'/users/42'</span>, {
  key: <span class="str">'42'</span>,
  timeout: <span class="num">1500</span>
});

console.<span class="fn">log</span>(<span class="kw">await</span> response.<span class="fn">json</span>());`,
    title: 'Peer calls with policy',
    note: 'Stable selection, deadlines, safe retries, circuit state and peer telemetry live in one layer.'
  },
  services: {
    filename: 'services.ts',
    plain: `import { ControlClient } from 'openmesh-node/services';
import { PeerPool } from 'openmesh-node/mesh';

const client = new ControlClient({
  url: 'http://control:4000/_mesh',
  token: process.env.OPENMESH_TOKEN
});

const pool = new PeerPool({
  peers: await client.discover('users')
});

const service = await client.watchService('users', {
  onUpdate(instances) {
    pool.updatePeers(instances);
  }
});

pool.updatePeers(service.instances);`,
    html: `<span class="kw">import</span> { ControlClient } <span class="kw">from</span> <span class="str">'openmesh-node/services'</span>;
<span class="kw">import</span> { PeerPool } <span class="kw">from</span> <span class="str">'openmesh-node/mesh'</span>;

<span class="kw">const</span> client = <span class="kw">new</span> <span class="fn">ControlClient</span>({
  url: <span class="str">'http://control:4000/_mesh'</span>,
  token: process.env.OPENMESH_TOKEN
});

<span class="kw">const</span> pool = <span class="kw">new</span> <span class="fn">PeerPool</span>({
  peers: <span class="kw">await</span> client.<span class="fn">discover</span>(<span class="str">'users'</span>)
});

<span class="kw">const</span> service = <span class="kw">await</span> client.<span class="fn">watchService</span>(<span class="str">'users'</span>, {
  <span class="fn">onUpdate</span>(instances) {
    pool.<span class="fn">updatePeers</span>(instances);
  }
});

pool.<span class="fn">updatePeers</span>(service.instances);`,
    title: 'Discovery as live state',
    note: 'Membership changes arrive as resumable snapshots and feed the routing layer directly.'
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