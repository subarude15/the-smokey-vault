/** Minimal types. nodemailer 7.0.9 does not ship its own declarations. */
declare module "nodemailer" {
  interface SmtpTransport {
    sendMail(options: {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html: string;
      replyTo?: string;
    }): Promise<unknown>;
    close(): void;
  }

  interface NodemailerModule {
    createTransport(options: {
      host: string;
      port: number;
      secure: boolean;
      auth?: { user: string; pass: string };
    }): SmtpTransport;
  }

  const nodemailer: NodemailerModule;
  export default nodemailer;
}
