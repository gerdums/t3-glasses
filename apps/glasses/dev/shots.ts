// Renders README screenshots from neutral sample data with the real renderer.
// Each click advances to the next shot; drive it with the simulator automation API.
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { EnvSummary, ThreadDetail, ThreadSummary } from '@t3-glasses/protocol';
import { actionItems, computersPage, homePage, threadPage, type Page } from '../src/render';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const envs: EnvSummary[] = [
  { id: 'studio', label: 'Mac Studio', connected: true, threadCount: 5, attention: { approval: 1, question: 0, failed: 0, running: 1 } },
  { id: 'laptop', label: 'MacBook Pro', connected: true, threadCount: 3, attention: { approval: 0, question: 1, failed: 0, running: 0 } },
  { id: 'server', label: 'Build server', connected: false, threadCount: 0, attention: { approval: 0, question: 0, failed: 0, running: 0 } },
];

const summary = (envId: string, project: string, title: string, attention: ThreadSummary['attention'], minutes: number): ThreadSummary => ({
  envId,
  envLabel: envs.find((env) => env.id === envId)!.label,
  id: title,
  title,
  projectTitle: project,
  status: attention === 'running' ? 'running' : 'idle',
  attention,
  updatedAt: ago(minutes),
});

const threads: ThreadSummary[] = [
  summary('studio', 'acme-web', 'Fix the flaky login test', 'approval', 1),
  summary('laptop', 'design-system', 'Name the new color tokens', 'question', 4),
  summary('studio', 'api', 'Add rate limiting to uploads', 'running', 2),
  summary('laptop', 'ios-app', 'Ship the offline mode', 'done', 35),
  summary('studio', 'acme-web', 'Upgrade to React 20', 'done', 80),
  summary('laptop', 'docs', 'Rewrite the quickstart', 'idle', 300),
];

const approval: ThreadDetail = {
  ...threads[0]!,
  status: 'running',
  messages: [
    { role: 'user', text: 'The login test fails about one run in ten on CI. Find out why and fix it.', at: ago(9) },
    {
      role: 'assistant',
      text: 'Found it: the test reads the session cookie before the redirect finishes. I added an explicit wait for the dashboard route. Running the suite 20 times to confirm.',
      at: ago(1),
    },
  ],
  canInterrupt: true,
  pending: {
    kind: 'approval',
    requestId: 'r1',
    requestKind: 'command',
    prompt: 'Run npm test -- --repeat 20 login.spec.ts',
    options: [
      { decision: 'accept', label: 'Approve' },
      { decision: 'acceptForSession', label: 'Approve for session' },
      { decision: 'decline', label: 'Deny' },
    ],
  },
};

const question: ThreadDetail = {
  ...threads[1]!,
  status: 'waiting',
  messages: [
    { role: 'user', text: 'Set up semantic color tokens for the new theme.', at: ago(12) },
    { role: 'assistant', text: 'I mapped all 48 colors. Before I rename them across the codebase, one decision:', at: ago(4) },
  ],
  canInterrupt: false,
  pending: {
    kind: 'question',
    requestId: 'q1',
    questions: [
      {
        id: 'naming',
        question: 'How should tokens be named?',
        options: [{ label: 'By role (surface, text, accent)' }, { label: 'By scale (gray-100 to gray-900)' }],
        multiSelect: false,
      },
    ],
  },
};

const running: ThreadDetail = {
  ...threads[2]!,
  messages: [
    { role: 'user', text: 'Add rate limiting to the upload endpoint: 10 per minute per user.', at: ago(6) },
    { role: 'assistant', text: 'Added a token-bucket limiter in middleware/rateLimit.ts and wired it to POST /uploads. Now running the API tests.', at: ago(2) },
  ],
  activity: '$ npm test -- uploads',
  canInterrupt: true,
};

const shots: Page[] = [
  homePage(threads, envs, '• Connected'),
  threadPage(approval),
  threadPage(approval, { card: { kind: 'actions', items: actionItems(approval) } }),
  threadPage(question, { card: { kind: 'actions', items: actionItems(question) } }),
  threadPage(running),
  threadPage(running, { card: { kind: 'transcript', text: 'Also cap total upload size at 50 MB per hour.' } }),
  computersPage(envs, '• Connected · 2 of 3 online'),
];

const bridge = await waitForEvenAppBridge();
let index = 0;
await bridge.createStartUpPageContainer(shots[0]!);
bridge.onEvenHubEvent((event) => {
  const clicked = event.listEvent ?? event.textEvent ?? event.sysEvent;
  if (!clicked || (clicked.eventType ?? 0) !== 0) return;
  index = (index + 1) % shots.length;
  void bridge.rebuildPageContainer(shots[index]!);
});
