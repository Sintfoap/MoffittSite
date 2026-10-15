// Sends email through Resend (resend.com), for confirming addresses and
// password-reset links. Needs the RESEND_API_KEY secret and the MAIL_FROM
// variable; without them the site hides everything to do with email.

export const mailReady = env => !!(env.MAILER || (env.RESEND_API_KEY && env.MAIL_FROM));

export async function sendMail(env, { to, subject, text }) {
  if (env.MAILER) return env.MAILER({ to, subject, text });   // tests
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 500);
    let reason; try { reason = JSON.parse(body).message; } catch {}
    throw new MailError(r.status, String(reason || body || "no details"));
  }
}

// A send Resend refused. `reason` is Resend's own explanation, such as
// "The sintfoap.xyz domain is not verified".
export class MailError extends Error {
  constructor(status, reason) { super(`email send failed: ${status} ${reason}`); this.status = status; this.reason = reason; }
}
