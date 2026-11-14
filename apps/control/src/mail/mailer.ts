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

export interface ActionsMail {
  to: string;
  name: string;
  actions: string[];
  link: string;
  /** When the link is a one-time password link, when it expires. */
  expiresAt?: Date;
  requestedBy: string;
  tenantName: string;
}

const ACTION_TEXT: Record<string, string> = {
  update_password: 'choose a new password',
  configure_second_step: 'set up a second step (an authenticator app or a passkey)',
  accept_terms: "accept your organization's terms",
};

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

  /** Keycloak's "execute actions" email: what an administrator (or a flow) asks the person to do, and where. */
  async sendActions(mail: ActionsMail): Promise<void> {
    const asks = mail.actions.map((a) => ACTION_TEXT[a] ?? a);
    const what = asks.length > 1 ? `${asks.slice(0, -1).join(', ')} and ${asks.at(-1)}` : asks[0];
    const hours = mail.expiresAt ? Math.round((mail.expiresAt.getTime() - Date.now()) / 3_600_000) : undefined;
    const button = mail.expiresAt ? 'Choose a new password' : 'Sign in';
    const after = hours
      ? `The link works once and expires in ${hours} hours.${mail.actions.length > 1 ? ' The rest happens at your next sign-in.' : ''}`
      : "You'll be asked when you sign in.";
    const text = [
      `Hi ${mail.name},`,
      '',
      `${mail.requestedBy} at ${mail.tenantName} asks you to ${what}.`,
      '',
      mail.link,
      '',
      after,
    ].join('\n');
    const html = `<p>Hi ${escapeHtml(mail.name)},</p><p>${escapeHtml(mail.requestedBy)} at ${escapeHtml(mail.tenantName)} asks you to ${escapeHtml(what ?? '')}.</p><p><a href="${escapeHtml(mail.link)}">${button}</a></p><p>${escapeHtml(after)}</p>`;
    await this.transport.sendMail({
      from: this.config.LANDBRIGHT_MAIL_FROM,
      to: mail.to,
      subject: `${mail.tenantName}: action needed on your Landbright account`,
      text,
      html,
    });
    this.logger.log(`required actions mail sent to ${mail.to}`);
  }
}
