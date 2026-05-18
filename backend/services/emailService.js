const nodemailer = require('nodemailer');
const { validateRecipients, startValidationWorker } = require('./emailValidationWorker');

startValidationWorker();

function isSmtpEnabled() {
  return String(process.env.SMTP_ENABLED || 'true').toLowerCase() !== 'false';
}

function createTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function normalizeRecipient(email) {
  return String(email || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !value.endsWith('@firebase.local'))
    .join(', ');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textToHtmlParagraphs(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return '<p style="margin:0;color:#334155;font-size:15px;line-height:1.7;">Ada pembaruan baru dari Pustara.</p>';

  const blocks = normalized
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    return '<p style="margin:0;color:#334155;font-size:15px;line-height:1.7;">Ada pembaruan baru dari Pustara.</p>';
  }

  return blocks
    .map((block) => {
      const safe = escapeHtml(block).replace(/\n/g, '<br/>');
      return `<p style="margin:0 0 16px 0;color:#334155;font-size:15px;line-height:1.7;">${safe}</p>`;
    })
    .join('');
}

function getEmailLogoUrl() {
  const explicitLogo = String(process.env.EMAIL_LOGO_URL || '').trim();
  if (explicitLogo) return explicitLogo;

  const baseUrl = String(
    process.env.PUBLIC_APP_URL
    || process.env.FRONTEND_PUBLIC_URL
    || process.env.NEXT_PUBLIC_SITE_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || ''
  ).trim().replace(/\/$/, '');

  if (!baseUrl) return '';
  return `${baseUrl}/Logo.png`;
}

function buildBrandedEmailHtml({ subject, text, html }) {
  const title = escapeHtml(subject || 'Pustara Notification');
  const bodyHtml = html ? String(html) : textToHtmlParagraphs(text);
  const logoUrl = getEmailLogoUrl();
  const logoBlock = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="Pustara Logo" style="width:44px;height:44px;display:block;object-fit:contain;"/>`
    : '<div style="color:#ffffff;font-size:30px;font-weight:800;letter-spacing:.5px;">Pustara</div>';

  return `
<!doctype html>
<html lang="id">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:Segoe UI,Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background:#334155;padding:20px 28px;">
                <div style="display:flex;align-items:center;gap:12px;">
                  ${logoBlock}
                  <div style="color:#ffffff;font-size:28px;font-weight:800;letter-spacing:.4px;">Pustara</div>
                </div>
                <div style="color:#cbd5e1;font-size:12px;margin-top:4px;">Digital Reading Companion</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 28px 18px 28px;">
                <h1 style="margin:0 0 14px 0;color:#0f172a;font-size:24px;line-height:1.35;font-weight:800;">${title}</h1>
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 28px 28px;">
                <div style="border-top:1px solid #e5e7eb;padding-top:14px;color:#64748b;font-size:12px;line-height:1.6;">
                  Email ini dikirim otomatis oleh sistem Pustara.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendEmail({ to, subject, text, html }) {
  if (!isSmtpEnabled()) {
    return { sent: false, reason: 'smtp disabled' };
  }

  const recipient = normalizeRecipient(to);
  if (!recipient) {
    return { sent: false, reason: 'invalid recipient' };
  }

  const validation = await validateRecipients(recipient);
  if (validation.validRecipients.length === 0) {
    return {
      sent: false,
      reason: 'no valid recipients',
      invalidRecipients: validation.invalidRecipients,
    };
  }

  const transporter = createTransport();
  if (!transporter) {
    return { sent: false, reason: 'smtp credentials incomplete' };
  }

  const subjectText = String(subject || 'Pustara Notification');
  const textBody = String(text || '');
  const htmlBody = buildBrandedEmailHtml({
    subject: subjectText,
    text: textBody,
    html,
  });

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER,
      to: validation.validRecipients.join(', '),
      subject: subjectText,
      text: textBody,
      html: htmlBody,
    });

    return {
      sent: true,
      sentRecipients: validation.validRecipients,
      skippedRecipients: validation.invalidRecipients,
    };
  } catch (error) {
    return {
      sent: false,
      reason: 'smtp_send_failed',
      error: error.message,
      attemptedRecipients: validation.validRecipients,
      skippedRecipients: validation.invalidRecipients,
    };
  }
}

module.exports = {
  sendEmail,
};
