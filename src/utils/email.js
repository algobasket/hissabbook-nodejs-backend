const nodemailer = require('nodemailer');

// Create reusable transporter for SMTP
function createTransporter() {
  const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtpSecure = process.env.SMTP_SECURE === 'true' || smtpPort === 465;
  const smtpUser = process.env.SMTP_USER || process.env.GMAIL_USER;
  const smtpPassword = process.env.SMTP_PASSWORD || process.env.GMAIL_APP_PASSWORD;

  if (!smtpUser || !smtpPassword) {
    throw new Error(
      'SMTP configuration missing. Please set SMTP_USER and SMTP_PASSWORD environment variables.'
    );
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: smtpUser,
      pass: smtpPassword,
    },
    tls: {
      rejectUnauthorized: process.env.NODE_ENV !== 'production',
    },
  });

  return transporter;
}

async function sendInviteEmail({ email, businessName, inviteLink, role, inviterName }) {
  const smtpUser = process.env.SMTP_USER || process.env.GMAIL_USER;
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.GMAIL_FROM_EMAIL || smtpUser || 'noreply@hissabbook.com';

  if (!smtpUser) {
    throw new Error('SMTP configuration missing. Please set SMTP_USER environment variable.');
  }

  const transporter = createTransporter();

  const roleText = role === 'Partner' ? 'Business Partner' : 'Staff Member';

  const mailOptions = {
    from: `"HissabBook" <${fromEmail}>`,
    to: email,
    subject: `You've been invited to join ${businessName} on HissabBook`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #2f4bff 0%, #2357FF 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 28px;">HissabBook</h1>
        </div>
        <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #e5e7eb;">
          <h2 style="color: #111827; margin-top: 0;">You've been invited!</h2>
          <p style="color: #6b7280; font-size: 16px; line-height: 1.6;">
            ${inviterName || 'Someone'} has invited you to join <strong>${businessName}</strong> as a <strong>${roleText}</strong> on HissabBook.
          </p>
          <div style="background: white; padding: 20px; border-radius: 8px; text-align: center; margin: 30px 0; border: 2px dashed #2f4bff;">
            <a href="${inviteLink}" style="display: inline-block; background: #2f4bff; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
              Accept Invitation
            </a>
          </div>
          <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            Or copy and paste this link into your browser:
          </p>
          <p style="color: #2f4bff; font-size: 12px; word-break: break-all; background: white; padding: 10px; border-radius: 4px; margin: 10px 0;">
            ${inviteLink}
          </p>
          <p style="color: #9ca3af; font-size: 12px; line-height: 1.6; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
            If you didn't expect this invitation, you can safely ignore this email.
          </p>
        </div>
      </div>
    `,
    text: `
HissabBook - You've been invited!

${inviterName || 'Someone'} has invited you to join ${businessName} as a ${roleText} on HissabBook.

Click this link to accept the invitation:
${inviteLink}

If you didn't expect this invitation, you can safely ignore this email.
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return {
      success: true,
      messageId: info.messageId,
    };
  } catch (error) {
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

module.exports = {
  sendInviteEmail,
  createTransporter,
};



