const nodemailer = require('nodemailer');

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
  const value = String(email || '').trim();
  if (!value) return '';
  if (value.endsWith('@firebase.local')) return '';
  return value;
}

async function sendEmail({ to, subject, text, html }) {
  if (!isSmtpEnabled()) {
    return { sent: false, reason: 'smtp disabled' };
  }

  const recipient = normalizeRecipient(to);
  if (!recipient) {
    return { sent: false, reason: 'invalid recipient' };
  }

  const transporter = createTransport();
  if (!transporter) {
    return { sent: false, reason: 'smtp credentials incomplete' };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER,
    to: recipient,
    subject: String(subject || 'Pustara Notification'),
    text: String(text || ''),
    html: html ? String(html) : undefined,
  });

  return { sent: true };
}

module.exports = {
  sendEmail,
};
