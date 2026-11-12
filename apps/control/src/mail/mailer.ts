import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Config } from '@landbright/platform';
import { CONFIG } from '@landbright/persistence';
import { createTransport, type Transporter } from 'nodemailer';

export interface InviteMail {
  to: string;
  name: string;
  link: string;
  expiresAt: Date;
  invitedBy: string;
  tenantName: string;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Outgoing mail, over SMTP (Mailpit in development: http://127.0.0.1:57825 shows what was sent). */
@Injectable()
export class Mailer {
  private readonly logger = new Logger(Mailer.name);
  private readonly transport: Transporter;

  constructor(@Inject(CONFIG) private readonly config: Config) {
    this.transport = createTransport(config.LANDBRIGHT_SMTP_URL);
  }

  async sendInvite(mail: InviteMail): Promise<void> {
    const hours = Math.round((mail.expiresAt.getTime() - Date.now()) / 3_600_000);
    const text = [
      `Hi ${mail.name},`,
      '',
      `${mail.invitedBy} added you to ${mail.tenantName} on Landbright. Set your password to sign in to your organization's apps:`,
      '',
      mail.link,
      '',
      `The link works once and expires in ${hours} hours.`,
    ].join('\n');
    const html = `<p>Hi ${escapeHtml(mail.name)},</p><p>${escapeHtml(mail.invitedBy)} added you to ${escapeHtml(mail.tenantName)} on Landbright. Set your password to sign in to your organization's apps.</p><p><a href="${escapeHtml(mail.link)}">Set your password</a></p><p>The link works once and expires in ${hours} hours.</p>`;
    await this.transport.sendMail({
      from: this.config.LANDBRIGHT_MAIL_FROM,
      to: mail.to,
      subject: `Set your Landbright password`,
      text,
      html,
    });
    this.logger.log(`invite sent to ${mail.to}`);
  }
}
