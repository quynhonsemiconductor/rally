/**
 * EmailTemplateRegistry — typed, DRY template system.
 *
 * Each template is a pure function: (vars) → { subject, html, text }.
 * Templates are rendered in-process — no external engine dependency.
 *
 * ADD A NEW TEMPLATE:
 *   1. Add a key to EmailTemplateName.
 *   2. Add the vars shape to EmailTemplateVars.
 *   3. Add the renderer to TEMPLATES map.
 *   That's it — the scheduler and relay pick it up automatically.
 *
 * HTML design:
 *   - Inline CSS (Outlook/Gmail safe)
 *   - Brand color #1d3f73 (matches the auth UI)
 *   - Plain-text fallback always provided
 */

import type { EmailCategory } from '../email.provider';

// ── Template name registry ───────────────────────────────────────────────────

export type EmailTemplateName = 'workspace-invitation' | 'notification';

// ── Per-template variable shapes (type-safe) ─────────────────────────────

export interface EmailTemplateVars {
  'workspace-invitation': {
    inviteUrl: string;
    workspaceName: string;
    expiresInDays: string; // e.g. "7"
    recipientEmail: string;
  };
  /**
   * Generic in-app notification delivered via email.
   * Used by NotificationRelayService when the user's email preference is enabled.
   * title/body come directly from the rendered in-app notification template.
   */
  notification: {
    title: string;
    body?: string;
    /** Human-readable resource label, e.g. "work item" or "workspace invitation". */
    resourceType?: string;
    /** Deep-link URL into the app for the relevant resource. */
    appUrl: string;
  };
}

// ── Rendered output ───────────────────────────────────────────────────────────

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /**
   * Template-level category metadata — controls which anti-spam headers
   * the transport layer adds (List-Unsubscribe, Precedence: bulk, etc.).
   * Set by the template renderer so callers never need to set it manually.
   */
  category: EmailCategory;
}

// ── Shared HTML layout ────────────────────────────────────────────────────────

function layout(title: string, preheader: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="x-apple-disable-message-reformatting"/>
  <title>${title}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Inter',Arial,sans-serif;">
  <!-- Preheader (hidden) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f0f2f5;">
    <tr><td align="center" style="padding:40px 16px;">
      <!-- Card -->
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;">
        <!-- Logo bar -->
        <tr><td style="padding-bottom:20px;">
          <table cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td style="background:#1d3f73;border-radius:8px;width:34px;height:34px;text-align:center;vertical-align:middle;">
                <span style="color:#fff;font-size:17px;font-weight:700;line-height:34px;">R</span>
              </td>
              <td style="padding-left:10px;vertical-align:middle;">
                <span style="font-size:15px;font-weight:600;color:#1a2234;">Mini Rova</span>
                <br/>
                <span style="font-size:10px;color:#8c94a6;">Work Management Platform</span>
              </td>
            </tr>
          </table>
        </td></tr>
        <!-- Body card -->
        <tr><td style="background:#fff;border-radius:8px;border:1px solid #d9dee7;overflow:hidden;">
          ${bodyHtml}
          <!-- Footer -->
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-top:1px solid #edf0f4;">
            <tr><td style="padding:18px 32px;text-align:center;">
              <span style="font-size:10px;color:#8c94a6;">
                © 2026 Mini Rova · Internal workspace · 
                <a href="#" style="color:#8c94a6;text-decoration:none;">Privacy</a>
              </span>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Template: workspace-invitation ───────────────────────────────────────────

function workspaceInvitation(vars: EmailTemplateVars['workspace-invitation']): RenderedEmail {
  const subject = `You've been invited to join ${vars.workspaceName} on Mini Rally`;

  const bodyHtml = `
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-bottom:1px solid #edf0f4;">
      <tr><td style="padding:28px 32px 24px;">
        <p style="margin:0 0 4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#8c94a6;">Workspace invitation</p>
        <h1 style="margin:0;font-size:20px;font-weight:600;color:#1a2234;line-height:1.3;">You've been invited</h1>
      </td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
      <tr><td style="padding:28px 32px;">
        <p style="margin:0 0 20px;font-size:13px;line-height:1.7;color:#3d4451;">
          You have been invited to join the workspace
          <strong style="color:#1a2234;">${vars.workspaceName}</strong> on Mini Rally.
        </p>
        <p style="margin:0 0 24px;font-size:13px;line-height:1.7;color:#3d4451;">
          This invitation expires in
          <strong style="color:#1a2234;">${vars.expiresInDays} day${vars.expiresInDays === '1' ? '' : 's'}</strong>.
          Click below to accept.
        </p>
        <table cellpadding="0" cellspacing="0" role="presentation">
          <tr><td style="border-radius:6px;background:#1d3f73;">
            <a href="${vars.inviteUrl}"
               style="display:inline-block;padding:11px 28px;font-size:13px;font-weight:600;color:#fff;text-decoration:none;border-radius:6px;line-height:1;">
              Accept invitation
            </a>
          </td></tr>
        </table>
        <p style="margin:20px 0 0;font-size:11px;color:#8c94a6;">
          Or copy this link:<br/>
          <a href="${vars.inviteUrl}" style="color:#2558a6;word-break:break-all;">${vars.inviteUrl}</a>
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:24px;border-top:1px solid #edf0f4;">
          <tr><td style="padding-top:18px;">
            <p style="margin:0;font-size:11px;line-height:1.6;color:#8c94a6;">
              If you were not expecting this invitation, you can safely ignore this email.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>`;

  const html = layout(subject, `You've been invited to ${vars.workspaceName}`, bodyHtml);

  const text = [
    `You've been invited to join ${vars.workspaceName} on Mini Rally`,
    '',
    `Click the link below to accept your invitation (valid for ${vars.expiresInDays} day${vars.expiresInDays === '1' ? '' : 's'}):`,
    vars.inviteUrl,
    '',
    'If you were not expecting this invitation, you can safely ignore this email.',
    '',
    '— Mini Rally',
  ].join('\n');

  return { subject, html, text, category: 'transactional' as const };
}

// ── Registry (maps template name → renderer) ─────────────────────────────────

function notification(vars: EmailTemplateVars['notification']): RenderedEmail {
  const subject = vars.title;

  const bodyHtml = `
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-bottom:1px solid #edf0f4;">
      <tr><td style="padding:28px 32px 24px;">
        <p style="margin:0 0 4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#8c94a6;">Notification</p>
        <h1 style="margin:0;font-size:18px;font-weight:600;color:#1a2234;line-height:1.4;">${vars.title}</h1>
      </td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
      <tr><td style="padding:24px 32px;">
        ${vars.body ? `<p style="margin:0 0 20px;font-size:13px;line-height:1.7;color:#3d4451;">${vars.body}</p>` : ''}
        <table cellpadding="0" cellspacing="0" role="presentation">
          <tr><td style="border-radius:6px;background:#1d3f73;">
            <a href="${vars.appUrl}"
               style="display:inline-block;padding:10px 24px;font-size:13px;font-weight:600;color:#fff;text-decoration:none;border-radius:6px;line-height:1;">
              View in Mini Rally
            </a>
          </td></tr>
        </table>
      </td></tr>
    </table>`;

  const text = [
    vars.title,
    '',
    ...(vars.body ? [vars.body, ''] : []),
    `Open in Mini Rally: ${vars.appUrl}`,
    '',
    '— Mini Rally',
  ].join('\n');

  return {
    subject,
    html: layout(subject, vars.title, bodyHtml),
    text,
    category: 'marketing' as const,
  };
}

const TEMPLATES: {
  [K in EmailTemplateName]: (vars: EmailTemplateVars[K]) => RenderedEmail;
} = {
  'workspace-invitation': workspaceInvitation,
  notification: notification,
};

/**
 * Render a named template with its typed variables.
 * Throws if the template name is unknown (config error, not user error).
 */
export function renderEmailTemplate<K extends EmailTemplateName>(
  name: K,
  vars: EmailTemplateVars[K],
): RenderedEmail {
  const renderer = TEMPLATES[name];
  if (!renderer) throw new Error(`Unknown email template: "${name}"`);
  return (renderer as (v: EmailTemplateVars[K]) => RenderedEmail)(vars);
}
