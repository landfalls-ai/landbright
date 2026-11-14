import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Config } from '@landbright/platform';
import { CONFIG } from '@landbright/persistence';
import { createTransport, type Transporter } from 'nodemailer';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The identity plane's own mail: password-reset links (Mailpit in development). */
@Injectable()
export class Mailer {
  private readonly logger = new Logger(Mailer.name);
  private readonly transport: Transporter;

  constructor(@Inject(CONFIG) private readonly config: Config) {
    this.transport = createTransport(config.LANDBRIGHT_SMTP_URL);
  }

  async sendReset(mail: { to: string; name: string; link: string; minutes: number; from: string }): Promise<void> {
    const text = [
      `Hi ${mail.name},`,
      '',
      'Someone (we hope you) asked to reset your Landbright password. Choose a new one here:',
      '',
      mail.link,
      '',
      `The link works once and expires in ${mail.minutes} minutes. If it wasn't you, ignore this email: your password stays as it is.`,
      `Asked from ${mail.from}.`,
    ].join('\n');
    const html = `<p>Hi ${escapeHtml(mail.name)},</p><p>Someone (we hope you) asked to reset your Landbright password.</p><p><a href="${escapeHtml(mail.link)}">Choose a new password</a></p><p>The link works once and expires in ${mail.minutes} minutes. If it wasn't you, ignore this email: your password stays as it is.</p><p>Asked from ${escapeHtml(mail.from)}.</p>`;
    await this.transport.sendMail({
      from: this.config.LANDBRIGHT_MAIL_FROM,
      to: mail.to,
      subject: 'Reset your Landbright password',
      text,
      html,
    });
    this.logger.log(`password reset link sent to ${mail.to}`);
  }
}
