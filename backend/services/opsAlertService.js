const { sendEmail } = require('./emailService');

function isEnabled() {
  return String(process.env.ALERT_EMAIL_ENABLED || '').toLowerCase() === 'true';
}

function getRecipients() {
  const raw = process.env.ALERT_EMAIL_TO || '';
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

async function sendOpsAlert(subject, details = []) {
  if (!isEnabled()) return { sent: false, reason: 'alert email disabled' };

  const recipients = getRecipients();
  if (recipients.length === 0) return { sent: false, reason: 'no recipients configured' };

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { sent: false, reason: 'smtp credentials incomplete' };
  }

  const now = new Date().toISOString();
  const lines = Array.isArray(details) ? details : [String(details || '')];
  const text = [
    `Time: ${now}`,
    ...lines,
  ].join('\n');

  const sendResult = await sendEmail({
    to: recipients.join(', '),
    subject,
    text,
  });

  if (!sendResult?.sent) {
    return { sent: false, reason: sendResult?.reason || 'failed to send email' };
  }

  return { sent: true, recipients: recipients.length };
}

module.exports = {
  sendOpsAlert,
};
