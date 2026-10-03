import { escapeHtml } from '../http-utils.js';

const PAGE_STYLE = `
  body { font-family: Georgia, serif; background: #f6f4ef; color: #1c1915; margin: 0; }
  main { max-width: 420px; margin: 8vh auto; background: #fff; padding: 32px; border: 1px solid #e4dfd6; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { line-height: 1.45; }
  label { display: block; font-size: 14px; margin: 14px 0 6px; }
  input[type="email"], input[type="password"] { width: 100%; box-sizing: border-box; padding: 10px; font-size: 16px; }
  button, a.button { display: inline-block; margin-top: 18px; margin-right: 8px; background: #1c1915; color: #fff; border: 0; padding: 10px 16px; font-size: 15px; cursor: pointer; text-decoration: none; }
  button.secondary, a.button.secondary { background: #fff; color: #1c1915; border: 1px solid #1c1915; }
  a.button .busy { display: none; align-items: center; gap: 8px; }
  a.button.is-loading, a.button:focus:not(:focus-visible) { cursor: progress; }
  a.button.is-loading .idle, a.button:focus:not(:focus-visible) .idle { display: none; }
  a.button.is-loading .busy, a.button:focus:not(:focus-visible) .busy { display: inline-flex; }
  .spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff; border-radius: 50%; animation: spin 0.7s linear infinite; }
  a.button.secondary .spinner { border-color: rgba(28,25,21,0.25); border-top-color: #1c1915; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error { background: #fff4f0; border: 1px solid #e7b2a4; padding: 10px; }
  .account { margin: 8px 0; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </main>
  <script>
    document.querySelectorAll('a.button').forEach(function (link) {
      link.addEventListener('click', function (event) {
        if (document.documentElement.dataset.pending === '1') {
          event.preventDefault();
          return;
        }
        document.documentElement.dataset.pending = '1';
        link.classList.add('is-loading');
        link.setAttribute('aria-busy', 'true');
      });
    });
  </script>
</body>
</html>`;
}

export interface AuthorizeForm {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
  resource: string;
  responseType: string;
}

function hidden(form: AuthorizeForm): string {
  const fields: Record<string, string> = {
    client_id: form.clientId,
    redirect_uri: form.redirectUri,
    code_challenge: form.codeChallenge,
    code_challenge_method: form.codeChallengeMethod,
    state: form.state,
    scope: form.scope,
    resource: form.resource,
    response_type: form.responseType,
  };
  return Object.entries(fields)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join('');
}

export function loginPage(form: AuthorizeForm, error?: string): string {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return page(
    'Connect ScrapeOps',
    `${errorHtml}
    <p>Sign in with your ScrapeOps account to let this application scrape on your behalf. Your API key stays on ScrapeOps servers.</p>
    <form method="post" action="/authorize/login">
      ${hidden(form)}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Continue</button>
    </form>`
  );
}

export function consentPage(options: {
  pendingId: string;
  clientName: string;
  email: string;
  accounts: { id: string; name: string }[];
}): string {
  const approveLinks = options.accounts
    .map((account) =>
      actionLink(
        decisionHref(options.pendingId, 'approve', account.id),
        options.accounts.length === 1 ? 'Approve' : `Approve ${account.name}`,
        'Approving…'
      )
    )
    .join('');

  return page(
    'Approve access',
    `<p><strong>${escapeHtml(options.clientName)}</strong> is requesting access to scrape using <strong>${escapeHtml(options.email)}</strong>.</p>
    <p>Requests use this account's ScrapeOps credits. The API key is not shared with the application.</p>
    <p>
      ${approveLinks}
      ${actionLink(decisionHref(options.pendingId, 'deny'), 'Deny', 'Denying…', true)}
    </p>`
  );
}

function actionLink(href: string, label: string, busyLabel: string, secondary = false): string {
  const className = secondary ? 'button secondary' : 'button';
  return `<a class="${className}" href="${href}"><span class="idle">${escapeHtml(label)}</span><span class="busy"><span class="spinner" aria-hidden="true"></span>${escapeHtml(busyLabel)}</span></a>`;
}

function decisionHref(pendingId: string, decision: 'approve' | 'deny', accountId?: string): string {
  const query = new URLSearchParams({ pending_id: pendingId, decision });
  if (accountId) query.set('account_id', accountId);
  return escapeHtml(`/authorize/decision?${query.toString()}`);
}

export function messagePage(title: string, message: string): string {
  return page(title, `<p>${escapeHtml(message)}</p>`);
}

export function revokePage(error?: string): string {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return page(
    'Revoke MCP access',
    `${errorHtml}
    <p>Sign in to disconnect Claude and other MCP clients from your ScrapeOps account.</p>
    <form method="post" action="/oauth/revoke-access">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Revoke access</button>
    </form>`
  );
}
